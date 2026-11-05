import { type CapabilityReport, heartbeatResponseSchema, helpRequestSchema } from '@netschool/contracts';
import { z } from 'zod';
import type { StateCache } from './cache.ts';
import { capabilityReport, type PlatformFacts } from './capabilities.ts';
import type { CommandProcessor } from './commands.ts';
import { type HubClient, HubError } from './hub-client.ts';
import type { OverlayController, OverlayView } from './overlay.ts';
import type { ThumbnailUploader } from './thumbnails.ts';

export type HubState = 'connecting' | 'online' | 'offline' | 'tls_error' | 'rejected';

export interface AgentStatus {
  hub: HubState;
  // Oxirgi muvaffaqiyatli heartbeat (devor soati, faqat ko'rsatish uchun).
  lastSeenAt: number | null;
  lessonId: string | null;
  overlay: OverlayView;
  // O'quvchi oynasida «Yumshoq bloklash» yoki «Bloklangan» deb ko'rsatish uchun.
  overlayEnforcement: 'soft' | 'hard';
  help: { id: string; raisedAt: string } | null;
  thumbnails: 'off' | 'on' | 'requires_permission' | 'unsupported';
}

export interface AgentOptions {
  heartbeatMs?: number; // 10_000
  pollWaitSeconds?: number; // 25
  capabilityCheckMs?: number; // 30_000
  overlayTickMs?: number; // 1_000
  backoffMinMs?: number; // 1_000
  backoffMaxMs?: number; // 30_000
  rejectedProbeMs?: number; // 60_000
}

const DEFAULTS: Required<AgentOptions> = {
  heartbeatMs: 10_000,
  pollWaitSeconds: 25,
  capabilityCheckMs: 30_000,
  overlayTickMs: 1_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  rejectedProbeMs: 60_000,
};

export interface AgentDeps {
  hub: HubClient;
  cache: StateCache;
  overlay: OverlayController;
  commands: CommandProcessor;
  thumbnails: ThumbnailUploader | null;
  facts: () => Promise<PlatformFacts>;
  // Berilmasa overlay yumshoq.
  enforcement?: () => 'soft' | 'hard';
  onStatus: (status: AgentStatus) => void;
}

// Buyruqlar alohida tekshiriladi (CommandProcessor): noma'lum turdagi bitta buyruq butun javobni buzmasin.
const pullSchema = z.object({ commands: z.array(z.unknown()) });

type ThumbnailCapability = 'available' | 'requires_permission' | 'unsupported';
type Directive = { intervalMs: number; maxWidth: number };

function thumbnailCapability(report: CapabilityReport): ThumbnailCapability {
  const state = report.capabilities['classroom.thumbnails']?.state;
  if (state === 'available' || state === 'requires_permission') return state;
  return 'unsupported';
}

// Qurilma sikllari: heartbeat (hub holatining yagona egasi), buyruq long-poll, capability yangilash, overlay lease.
export class CompanionAgent {
  readonly #deps: AgentDeps;
  readonly #opts: Required<AgentOptions>;
  #running = false;
  #abort = new AbortController();
  readonly #sleepers = new Set<() => void>();
  #loops: Promise<void>[] = [];
  #status: AgentStatus;
  #lastEmitted = '';
  #unauthorized = 0;
  #sentReport: string | null = null;
  #thumbnailCapability: ThumbnailCapability = 'available';
  #directive: Directive | null = null;

  constructor(deps: AgentDeps, opts: AgentOptions = {}) {
    this.#deps = deps;
    this.#opts = {
      ...DEFAULTS,
      ...opts,
      pollWaitSeconds: Math.max(1, opts.pollWaitSeconds ?? DEFAULTS.pollWaitSeconds),
    };
    this.#status = {
      hub: 'connecting',
      lastSeenAt: null,
      lessonId: null,
      overlay: deps.overlay.view(),
      overlayEnforcement: deps.enforcement?.() ?? 'soft',
      help: null,
      thumbnails: 'off',
    };
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#abort = new AbortController();
    this.#deps.overlay.restore();
    this.#emit();
    this.#loops = [this.#heartbeatLoop(), this.#pollLoop(), this.#capabilityLoop(), this.#overlayLoop()];
  }

  // Hamma hub so'rovlari (heartbeat, capability, long-poll, receipt) bekor qilinadi: chiqish/o'chirish kutib qolmaydi.
  async stop(): Promise<void> {
    this.#running = false;
    this.#abort.abort();
    for (const wake of [...this.#sleepers]) wake();
    this.#deps.thumbnails?.stop();
    await Promise.allSettled(this.#loops);
    this.#loops = [];
  }

  async raiseHelp(): Promise<void> {
    const help = await this.#deps.hub.json('POST', '/api/v1/device/help-request', {}, helpRequestSchema);
    this.#status = { ...this.#status, help: { id: help.id, raisedAt: help.raisedAt } };
    this.#emit();
  }

  async withdrawHelp(): Promise<void> {
    await this.#deps.hub.json('DELETE', '/api/v1/device/help-request', undefined, null);
    this.#status = { ...this.#status, help: null };
    this.#emit();
  }

  async #heartbeatLoop(): Promise<void> {
    let backoff = this.#opts.backoffMinMs;
    while (this.#running) {
      try {
        const hb = await this.#deps.hub.json('POST', '/api/v1/device/heartbeat', {}, heartbeatResponseSchema, {
          signal: this.#abort.signal,
        });
        this.#unauthorized = 0;
        backoff = this.#opts.backoffMinMs;
        // Overlay hub javobi bilan bir vaqtda yangilanadi: 'online' paytida eskirgan lock ko'rinmaydi.
        this.#deps.overlay.applyHeartbeat(hb.lesson);
        this.#directive = hb.lesson?.thumbnails ?? null;
        this.#status = {
          ...this.#status,
          hub: 'online',
          lastSeenAt: Date.now(),
          lessonId: hb.lesson?.id ?? null,
          help: hb.lesson?.helpRequest ?? null,
        };
        this.#syncThumbnails();
        this.#emit();
        await this.#sleep(this.#opts.heartbeatMs);
      } catch (err) {
        if (!this.#running) return;
        const hub = this.#classify(err);
        this.#status = { ...this.#status, hub };
        this.#emit();
        await this.#sleep(hub === 'rejected' ? this.#opts.rejectedProbeMs : backoff);
        backoff = Math.min(backoff * 2, this.#opts.backoffMaxMs);
      }
    }
  }

  // TLS xatosi ishonchni yumshatmaydi: holat ko'rsatiladi va urinish davom etadi. Ketma-ket ikki 401 (HubClient bir marta
  // qayta imzolagandan keyin) — qurilma hub tomonidan rad etilgan.
  #classify(err: unknown): HubState {
    if (err instanceof HubError) {
      if (err.kind === 'tls') {
        this.#unauthorized = 0;
        return 'tls_error';
      }
      if (err.kind === 'http' && err.status === 401) return ++this.#unauthorized >= 2 ? 'rejected' : 'offline';
    }
    this.#unauthorized = 0;
    return 'offline';
  }

  async #pollLoop(): Promise<void> {
    let backoff = this.#opts.backoffMinMs;
    while (this.#running) {
      if (this.#status.hub === 'rejected') {
        await this.#sleep(this.#opts.rejectedProbeMs);
        continue;
      }
      try {
        const wait = this.#opts.pollWaitSeconds;
        const res = await this.#deps.hub.json('GET', `/api/v1/device/commands?wait=${wait}`, undefined, pullSchema, {
          lane: 'poll',
          timeoutMs: (wait + 10) * 1000,
          signal: this.#abort.signal,
        });
        backoff = this.#opts.backoffMinMs;
        if (res.commands.length > 0) {
          await this.#deps.commands.handleBatch(res.commands, this.#abort.signal);
          this.#emit();
        }
      } catch {
        if (!this.#running) return;
        await this.#sleep(backoff);
        backoff = Math.min(backoff * 2, this.#opts.backoffMaxMs);
      }
    }
  }

  // Capability faqat o'zgarganda yuboriladi; ruxsat berilsa/olinsa miniatura darhol mos holatga o'tadi.
  async #capabilityLoop(): Promise<void> {
    let backoff = this.#opts.backoffMinMs;
    while (this.#running) {
      try {
        const report = capabilityReport(await this.#deps.facts());
        this.#thumbnailCapability = thumbnailCapability(report);
        const key = JSON.stringify(report);
        if (key !== this.#sentReport) {
          await this.#deps.hub.json('PUT', '/api/v1/device/capabilities', report, null, { signal: this.#abort.signal });
          this.#sentReport = key;
        }
        backoff = this.#opts.backoffMinMs;
        this.#syncThumbnails();
        this.#emit();
        await this.#sleep(this.#opts.capabilityCheckMs);
      } catch {
        if (!this.#running) return;
        await this.#sleep(Math.min(backoff, this.#opts.capabilityCheckMs));
        backoff = Math.min(backoff * 2, this.#opts.backoffMaxMs);
      }
    }
  }

  async #overlayLoop(): Promise<void> {
    while (this.#running) {
      await this.#sleep(this.#opts.overlayTickMs);
      if (!this.#running) return;
      this.#deps.overlay.tick();
      this.#emit();
    }
  }

  #syncThumbnails(): void {
    const capability = this.#thumbnailCapability;
    const directive = this.#directive;
    const uploader = this.#deps.thumbnails;
    if (uploader) {
      if (directive && capability === 'available') uploader.start(directive);
      else uploader.stop();
    }
    this.#status = {
      ...this.#status,
      thumbnails: capability !== 'available' ? capability : directive ? 'on' : 'off',
    };
  }

  #emit(): void {
    this.#status = {
      ...this.#status,
      overlay: this.#deps.overlay.view(),
      overlayEnforcement: this.#deps.enforcement?.() ?? 'soft',
    };
    const json = JSON.stringify(this.#status);
    if (json === this.#lastEmitted) return;
    this.#lastEmitted = json;
    this.#deps.onStatus(this.#status);
  }

  #sleep(ms: number): Promise<void> {
    if (!this.#running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#sleepers.add(done);
    });
  }
}
