import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  type Actor,
  authorize,
  THUMBNAIL_INTERVAL_MS,
  THUMBNAIL_STREAM_MAX_BUFFER,
  THUMBNAIL_STREAM_RECHECK_MS,
} from '@netschool/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { type WebSocket, WebSocketServer } from 'ws';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { refuse, UpgradeRouter } from '../../common/upgrade-router.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import { lessonDevices, lessons } from '../../db/schema.ts';
import { loadActor } from '../identity/actor.loader.ts';
import { readSessionCookie, SessionService } from '../identity/sessions.ts';
import { ThumbnailStore } from './thumbnail-store.ts';

const STREAM_PATH = /^\/api\/v1\/lessons\/([^/]+)\/thumbnails\/stream$/;
const PING_INTERVAL_MS = 30_000;

type LessonRow = typeof lessons.$inferSelect;

interface Viewer {
  ws: WebSocket;
  lessonId: string;
  token: string;
  members: Set<string>;
  lastSent: Map<string, number>;
  pending: Map<string, NodeJS.Timeout>;
  alive: boolean;
}

// Binary xabar: 16 bayt qurilma UUID + JPEG. Sekin klientda (bufer to'lgan) kadr tashlanadi — latest-frame (§11).
export function pushFrame(
  target: { bufferedAmount: number; send(data: Buffer): void },
  deviceId: string,
  jpeg: Buffer,
): 'sent' | 'dropped' {
  if (target.bufferedAmount > THUMBNAIL_STREAM_MAX_BUFFER) return 'dropped';
  target.send(Buffer.concat([Buffer.from(deviceId.replace(/-/g, ''), 'hex'), jpeg]));
  return 'sent';
}

const canView = (actor: Actor, lesson: LessonRow) =>
  authorize(actor, 'remote.view', {
    organizationId: lesson.organizationId,
    siteId: lesson.siteId,
    roomId: lesson.roomId,
    ownerUserId: lesson.teacherUserId,
  }).allowed;

// O'qituvchi setkasi uchun jonli miniaturalar (ADR 0009: WS fan-out). Cookie sessiya, Origin = PUBLIC_ORIGIN,
// remote.view (dars egasi yoki admin). Har qurilmadan ≤1 kadr / THUMBNAIL_INTERVAL_MS.
@Injectable()
export class ThumbnailStream implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #log = new Logger('ThumbnailStream');
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  readonly #viewers = new Set<Viewer>();
  #unroute: (() => void) | undefined;
  #offFrame: (() => void) | undefined;
  #recheckTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(UpgradeRouter) private readonly router: UpgradeRouter,
    @Inject(ThumbnailStore) private readonly store: ThumbnailStore,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(Access) private readonly access: Access,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  onApplicationBootstrap(): void {
    this.#unroute = this.router.route(STREAM_PATH, (req, socket, head) => {
      void this.#upgrade(req, socket, head).catch((err: unknown) => {
        this.#log.error(`thumbnail stream upgrade failed: ${err instanceof Error ? err.message : 'unknown'}`);
        if (!socket.destroyed) refuse(socket, 500, 'Internal Server Error');
      });
    });
    this.#offFrame = this.store.onFrame((deviceId, lessonId) => this.#onFrame(deviceId, lessonId));
    this.#recheckTimer = setInterval(() => void this.recheck(), THUMBNAIL_STREAM_RECHECK_MS);
    this.#recheckTimer.unref();
    this.#pingTimer = setInterval(() => this.#ping(), PING_INTERVAL_MS);
    this.#pingTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.#unroute?.();
    this.#offFrame?.();
    clearInterval(this.#recheckTimer);
    clearInterval(this.#pingTimer);
    for (const v of this.#viewers) this.#drop(v);
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (req.method !== 'GET') return refuse(socket, 400, 'Bad Request');
    // Brauzer WS'da CORS yo'q: Origin aynan panel origin'i bo'lishi shart (CSWSH).
    if (req.headers.origin !== this.config.publicOrigin) return refuse(socket, 403, 'Forbidden');
    const token = readSessionCookie(req.headers.cookie);
    const session = await this.sessions.resolve(token);
    const loaded = session ? await loadActor(this.db, session.userId) : null;
    if (!session || !token || !loaded || loaded.user.disabledAt) return refuse(socket, 401, 'Unauthorized');
    if (loaded.user.mustChangePassword) return refuse(socket, 403, 'Forbidden');
    const ctx: RequestContext = {
      correlationId: randomUUID(),
      clientIp: req.socket.remoteAddress ?? '',
      actor: loaded.actor,
      sessionId: session.sessionId,
    };
    const lessonId = STREAM_PATH.exec(new URL(req.url ?? '', 'https://localhost').pathname)?.[1] ?? '';
    const [lesson] = isUuid(lessonId)
      ? await this.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.id, lessonId), eq(lessons.organizationId, loaded.actor.organizationId)))
      : [];
    try {
      if (!lesson) await this.access.deny(ctx, 'remote.view', { targetType: 'lesson', targetId: lessonId });
      else
        await this.access.require(
          ctx,
          'remote.view',
          {
            organizationId: lesson.organizationId,
            siteId: lesson.siteId,
            roomId: lesson.roomId,
            ownerUserId: lesson.teacherUserId,
          },
          { targetType: 'lesson', targetId: lesson.id },
        );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'scope_denied') return refuse(socket, 403, 'Forbidden');
      throw err;
    }
    if (lesson?.status !== 'active') return refuse(socket, 409, 'Conflict');
    const members = await this.#members(lesson.id);
    if (socket.destroyed) return;
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, lesson.id, token, members));
  }

  async #members(lessonId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ deviceId: lessonDevices.deviceId })
      .from(lessonDevices)
      .where(and(eq(lessonDevices.lessonId, lessonId), isNull(lessonDevices.releasedAt)));
    return new Set(rows.map((r) => r.deviceId));
  }

  #accept(ws: WebSocket, lessonId: string, token: string, members: Set<string>): void {
    const viewer: Viewer = { ws, lessonId, token, members, lastSent: new Map(), pending: new Map(), alive: true };
    this.#viewers.add(viewer);
    ws.on('pong', () => {
      viewer.alive = true;
    });
    ws.on('error', () => {});
    ws.on('message', () => ws.close(1003, 'server push only'));
    ws.on('close', () => this.#drop(viewer));
    // Ulanganda mavjud oxirgi kadrlar darhol.
    for (const deviceId of members) this.#deliver(viewer, deviceId);
  }

  #onFrame(deviceId: string, lessonId: string): void {
    for (const v of this.#viewers) {
      if (v.lessonId === lessonId && v.members.has(deviceId)) this.#deliver(v, deviceId);
    }
  }

  // Interval ichida kelgan kadr tashlanmaydi: interval tugaganda o'sha paytdagi eng oxirgi kadr yuboriladi.
  #deliver(v: Viewer, deviceId: string): void {
    if (v.ws.readyState !== v.ws.OPEN || v.pending.has(deviceId)) return;
    const wait = (v.lastSent.get(deviceId) ?? Number.NEGATIVE_INFINITY) + THUMBNAIL_INTERVAL_MS - this.now();
    if (wait > 0) {
      const timer = setTimeout(() => {
        v.pending.delete(deviceId);
        this.#deliver(v, deviceId);
      }, wait);
      timer.unref();
      v.pending.set(deviceId, timer);
      return;
    }
    const frame = this.store.latest(deviceId, v.lessonId);
    if (!frame) return;
    if (pushFrame(v.ws, deviceId, frame.jpeg) === 'sent') v.lastSent.set(deviceId, this.now());
  }

  // Sessiya, ruxsat va dars holati qayta tekshiriladi; a'zolar yangilanadi.
  async recheck(): Promise<void> {
    for (const v of [...this.#viewers]) {
      try {
        const session = await this.sessions.resolve(v.token);
        const loaded = session ? await loadActor(this.db, session.userId) : null;
        const [lesson] = await this.db.select().from(lessons).where(eq(lessons.id, v.lessonId));
        if (!loaded || loaded.user.disabledAt || !lesson || !canView(loaded.actor, lesson)) {
          v.ws.close(4401, 'unauthorized');
        } else if (lesson.status !== 'active') {
          v.ws.close(4410, 'lesson_ended');
        } else {
          v.members = await this.#members(v.lessonId);
        }
      } catch (err) {
        this.#log.error(`thumbnail stream recheck failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }

  #drop(v: Viewer): void {
    for (const timer of v.pending.values()) clearTimeout(timer);
    v.pending.clear();
    this.#viewers.delete(v);
    if (v.ws.readyState === v.ws.OPEN) v.ws.terminate();
  }

  #ping(): void {
    for (const v of this.#viewers) {
      if (!v.alive) {
        v.ws.terminate();
        continue;
      }
      v.alive = false;
      v.ws.ping();
    }
  }
}
