import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { THUMBNAIL_MAX_BYTES } from '@netschool/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { ApiError } from '../../common/errors.ts';
import { DB, type Db } from '../../db/client.ts';
import { lessonDevices, lessons } from '../../db/schema.ts';
import { DeviceVerifier } from '../devices/device-verifier.ts';
import { ThumbnailStore } from './thumbnail-store.ts';

export const THUMBNAIL_PATH = '/api/v1/device/thumbnails';
const MEMBERSHIP_RECHECK_MS = 5_000;
const PING_INTERVAL_MS = 30_000;

interface Connection {
  ws: WebSocket;
  deviceId: string;
  lessonId: string;
  checkedAt: number;
  alive: boolean;
  // Kadrlar ketma-ket qayta ishlanadi: a'zolik tekshiruvi kutilayotganda kelgan kadr undan o'tib ketmaydi.
  queue: Promise<void>;
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Qurilmadan JPEG miniaturalar: imzolangan WS upgrade, API jarayonida (§11). Kadr faqat ThumbnailStore'ga tushadi.
@Injectable()
export class ThumbnailIngest implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #log = new Logger('ThumbnailIngest');
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: THUMBNAIL_MAX_BYTES });
  readonly #connections = new Map<string, Connection>();
  #server: ReturnType<HttpAdapterHost['httpAdapter']['getHttpServer']> | undefined;
  #pingTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(DeviceVerifier) private readonly verifier: DeviceVerifier,
    @Inject(ThumbnailStore) private readonly store: ThumbnailStore,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  onApplicationBootstrap(): void {
    this.#server = this.adapterHost.httpAdapter.getHttpServer();
    this.#server.on('upgrade', this.#onUpgrade);
    this.#pingTimer = setInterval(() => this.#ping(), PING_INTERVAL_MS);
    this.#pingTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.#server?.off('upgrade', this.#onUpgrade);
    clearInterval(this.#pingTimer);
    for (const conn of this.#connections.values()) conn.ws.terminate();
    this.#connections.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  readonly #onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => {}); // upgrade kutilayotganda uzilgan soket jarayonni yiqitmasin
    void this.#upgrade(req, socket, head).catch((err: unknown) => {
      this.#log.error(`thumbnail upgrade failed: ${err instanceof Error ? err.message : 'unknown'}`);
      if (!socket.destroyed) refuse(socket, 500, 'Internal Server Error');
    });
  };

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = req.url ?? '';
    if (req.method !== 'GET' || new URL(url, 'https://localhost').pathname !== THUMBNAIL_PATH) {
      refuse(socket, 400, 'Bad Request');
      return;
    }
    let device: Awaited<ReturnType<DeviceVerifier['verify']>>;
    try {
      device = await this.verifier.verify('GET', url, req.headers, Buffer.alloc(0));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthenticated') {
        refuse(socket, 401, 'Unauthorized');
        return;
      }
      throw err;
    }
    const lessonId = await this.#activeLesson(device.id);
    if (!lessonId) {
      refuse(socket, 409, 'Conflict');
      return;
    }
    if (socket.destroyed) return;
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, device.id, lessonId));
  }

  // A'zolik: qurilmaning bo'shatilmagan lesson_devices qatori va `active` dars (PresenceService.heartbeat bilan bir xil).
  async #activeLesson(deviceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ lessonId: lessonDevices.lessonId })
      .from(lessonDevices)
      .innerJoin(lessons, eq(lessons.id, lessonDevices.lessonId))
      .where(and(eq(lessonDevices.deviceId, deviceId), isNull(lessonDevices.releasedAt), eq(lessons.status, 'active')));
    return row?.lessonId ?? null;
  }

  #accept(ws: WebSocket, deviceId: string, lessonId: string): void {
    // Bitta qurilmada bitta soket: yangisi eskisini almashtiradi.
    this.#connections.get(deviceId)?.ws.close(4000, 'replaced');
    const conn: Connection = { ws, deviceId, lessonId, checkedAt: this.now(), alive: true, queue: Promise.resolve() };
    this.#connections.set(deviceId, conn);

    ws.on('pong', () => {
      conn.alive = true;
    });
    // maxPayload oshganda ws 1009 bilan yopadi va 'error' chiqaradi; ushlanmasa jarayon yiqiladi.
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.#connections.get(deviceId) === conn) this.#connections.delete(deviceId);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, 'binary only');
        return;
      }
      conn.queue = conn.queue
        .then(() => this.#frame(conn, data))
        .catch((err: unknown) => {
          this.#log.error(`thumbnail frame failed: ${err instanceof Error ? err.message : 'unknown'}`);
        });
    });
  }

  async #frame(conn: Connection, data: RawData): Promise<void> {
    if (conn.ws.readyState !== conn.ws.OPEN || !Buffer.isBuffer(data)) return;
    const at = this.now();
    if (at - conn.checkedAt >= MEMBERSHIP_RECHECK_MS) {
      const current = await this.#activeLesson(conn.deviceId);
      conn.checkedAt = at;
      if (current !== conn.lessonId) {
        conn.ws.close(4409, 'left_lesson');
        return;
      }
    }
    this.store.put(conn.deviceId, conn.lessonId, data);
  }

  // Javob bermagan soket uziladi.
  #ping(): void {
    for (const conn of this.#connections.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }
}
