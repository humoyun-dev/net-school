import { createPrivateKey } from 'node:crypto';
import type { Agent } from 'node:https';
import { THUMBNAIL_MAX_BYTES } from '@netschool/domain';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { seedDevice } from '../../api/test/support/device.ts';
import { startLesson } from '../../api/test/support/lesson.ts';
import { loginAs } from '../../api/test/support/login.ts';
import { seedOrg, seedRoom, seedUser } from '../../api/test/support/seed.ts';
import { HubClient } from '../src/core/hub-client.ts';
import { type DeviceIdentity, generateDeviceKey, RequestSigner, type SignedHeaders } from '../src/core/identity.ts';
import {
  type ConnectSocket,
  type FrameSource,
  type ThumbnailSocket,
  ThumbnailUploader,
} from '../src/core/thumbnails.ts';

const DIRECTIVE = { intervalMs: 1_000, maxWidth: 480 };
const jpeg = (label: string | number) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`frame-${label}`)]);

function localIdentity(): DeviceIdentity {
  const { publicKey, privateKeyPem } = generateDeviceKey();
  return { deviceId: '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a', publicKey, privateKey: createPrivateKey(privateKeyPem) };
}

class FakeSocket implements ThumbnailSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  readonly closeCalls: (number | undefined)[] = [];
  readonly #handlers: Record<'open' | 'close' | 'error', ((...a: unknown[]) => void)[]> = {
    open: [],
    close: [],
    error: [],
  };

  send(data: Buffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closeCalls.push(code);
    this.readyState = 3;
  }
  on(event: 'open' | 'close' | 'error', listener: (...a: unknown[]) => void): void {
    this.#handlers[event].push(listener);
  }
  emitOpen(): void {
    this.readyState = 1;
    for (const l of this.#handlers.open) l();
  }
  emitClose(code: number): void {
    this.readyState = 3;
    for (const l of this.#handlers.close) l(code);
  }
}

function fakes() {
  const sockets: FakeSocket[] = [];
  const connects: { url: string; headers: SignedHeaders; agent: Agent }[] = [];
  const connect: ConnectSocket = (url, headers, agent) => {
    connects.push({ url, headers, agent });
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const widths: number[] = [];
  let frame: () => Buffer | null | Promise<Buffer | null> = () => jpeg('x');
  const source: FrameSource = {
    capture: async (maxWidth) => {
      widths.push(maxWidth);
      return frame();
    },
  };
  const hub = new HubClient({ origin: 'https://hub.school.lan', ca: null, signer: null });
  const uploader = new ThumbnailUploader({ hub, signer: new RequestSigner(localIdentity()), source, connect });
  return {
    sockets,
    connects,
    widths,
    uploader,
    hub,
    setFrame: (f: typeof frame) => {
      frame = f;
    },
    // Birinchi ulanishni ochadi va tick'dagi capture tugashini kutadi.
    open: async (index = 0) => {
      sockets[index]?.emitOpen();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe('thumbnail uploader (fake socket)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('connects to the signed thumbnail socket of the hub and sends a frame when it opens', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start({ intervalMs: 1_000, maxWidth: 320 });
    expect(f.connects).toHaveLength(1);
    expect(f.connects[0]?.url).toBe('wss://hub.school.lan/api/v1/device/thumbnails');
    expect(f.connects[0]?.headers['x-ns-device-id']).toBe('7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a');
    expect(f.connects[0]?.headers['x-ns-signature']).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(f.connects[0]?.agent).toBe(f.hub.agent); // TLS/CA hub klienti bilan bir xil
    expect(f.uploader.streaming).toBe(false);
    await f.open();
    expect(f.uploader.streaming).toBe(true);
    expect(f.widths).toEqual([320]);
    expect(f.sockets[0]?.sent).toEqual([jpeg('x')]);
    f.uploader.stop();
  });

  test('null frames from the source are not sent', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.setFrame(() => null);
    f.uploader.start(DIRECTIVE);
    await f.open();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.widths.length).toBeGreaterThanOrEqual(3); // capture urinishlari davom etadi
    expect(f.sockets[0]?.sent).toEqual([]);
    f.setFrame(() => jpeg('ok'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.sockets[0]?.sent).toEqual([jpeg('ok')]);
    f.uploader.stop();
  });

  test('frames above the size limit are not sent but the limit itself is', async () => {
    vi.useFakeTimers();
    const f = fakes();
    const sized = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n - 3)]);
    f.setFrame(() => sized(THUMBNAIL_MAX_BYTES + 1));
    f.uploader.start(DIRECTIVE);
    await f.open();
    expect(f.sockets[0]?.sent).toEqual([]);
    f.setFrame(() => sized(THUMBNAIL_MAX_BYTES));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.sockets[0]?.sent).toHaveLength(1);
    f.uploader.stop();
  });

  test('no capture while the previous frame is still buffered', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    await f.open();
    expect(f.widths).toHaveLength(1);
    const socket = f.sockets[0];
    if (!socket) throw new Error('no socket');
    socket.bufferedAmount = 4_096;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.widths).toHaveLength(1); // navbat yo'q: capture ham qilinmaydi
    expect(socket.sent).toHaveLength(1);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.widths).toHaveLength(2);
    f.uploader.stop();
  });

  test('the interval never drops below 500 ms', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start({ intervalMs: 10, maxWidth: 480 });
    await f.open();
    expect(f.widths).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(f.widths).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.widths).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.widths).toHaveLength(3);
    f.uploader.stop();
  });

  test('a repeated start is a no-op and a changed directive takes effect on the open stream', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    f.uploader.start(DIRECTIVE);
    expect(f.connects).toHaveLength(1);
    await f.open();
    f.uploader.start({ intervalMs: 2_000, maxWidth: 320 });
    expect(f.connects).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.widths).toEqual([480]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.widths).toEqual([480, 320]);
    f.uploader.stop();
  });

  test('a failing capture skips the frame and the loop continues', async () => {
    vi.useFakeTimers();
    const f = fakes();
    let calls = 0;
    f.setFrame(() => {
      if (++calls === 1) throw new Error('capture failed');
      return jpeg(calls);
    });
    f.uploader.start(DIRECTIVE);
    await f.open();
    expect(f.sockets[0]?.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.sockets[0]?.sent).toEqual([jpeg(2)]);
    f.uploader.stop();
  });

  test('stop closes the stream and capture ends', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    await f.open();
    const socket = f.sockets[0];
    f.uploader.stop();
    expect(socket?.closeCalls).toEqual([1000]);
    expect(f.uploader.streaming).toBe(false);
    const before = f.widths.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.widths).toHaveLength(before);
    expect(f.connects).toHaveLength(1); // qayta ulanish ham yo'q
    f.uploader.stop(); // ikkinchi stop xavfsiz
  });

  test('a frame captured after stop is not sent', async () => {
    vi.useFakeTimers();
    const f = fakes();
    let release: (b: Buffer) => void = () => {};
    f.setFrame(() => new Promise<Buffer>((resolve) => (release = resolve)));
    f.uploader.start(DIRECTIVE);
    f.sockets[0]?.emitOpen();
    await vi.advanceTimersByTimeAsync(0);
    f.uploader.stop();
    release(jpeg('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sockets[0]?.sent).toEqual([]);
  });

  test('after a left_lesson close the uploader waits for the next start', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    await f.open();
    f.sockets[0]?.emitClose(4409);
    expect(f.uploader.streaming).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.connects).toHaveLength(1);
    const captures = f.widths.length;
    f.uploader.start(DIRECTIVE); // keyingi heartbeat yo'riqnomasi
    expect(f.connects).toHaveLength(2);
    await f.open(1);
    expect(f.widths.length).toBe(captures + 1);
    f.uploader.stop();
  });

  test('a stream replaced by another Companion is not fought over', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    await f.open();
    f.sockets[0]?.emitClose(4000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.connects).toHaveLength(1);
    f.uploader.start(DIRECTIVE);
    expect(f.connects).toHaveLength(2);
    f.uploader.stop();
  });

  test('reconnects after the hub drops the socket with a growing backoff', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    await f.open(0);
    f.sockets[0]?.emitClose(1006);
    expect(f.uploader.streaming).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(f.connects).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.connects).toHaveLength(2); // 1 s

    f.sockets[1]?.emitClose(1006); // ochilmasdan yiqildi: backoff 2 s
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.connects).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.connects).toHaveLength(3);

    f.sockets[2]?.emitClose(1006); // 4 s
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.connects).toHaveLength(4);

    // Muvaffaqiyatli ochilgach backoff boshiga qaytadi.
    await f.open(3);
    f.sockets[3]?.emitClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.connects).toHaveLength(5);
    f.uploader.stop();
  });

  test('the backoff is capped at 30 seconds', async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.uploader.start(DIRECTIVE);
    let expected = 1;
    for (let i = 0; i < 8; i++) {
      f.sockets[i]?.emitClose(1006);
      await vi.advanceTimersByTimeAsync(Math.min(2 ** i, 30) * 1_000);
      expected++;
      expect(f.connects, `after drop ${i}`).toHaveLength(expected);
    }
    // 2^5 = 32 s kutilishi kerak edi, lekin 30 s dan oshmaydi.
    f.sockets[8]?.emitClose(1006);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.connects).toHaveLength(expected + 1);
    f.uploader.stop();
  });

  test('a connect that throws is retried with the backoff', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const hub = new HubClient({ origin: 'https://hub.school.lan', ca: null, signer: null });
    const uploader = new ThumbnailUploader({
      hub,
      signer: new RequestSigner(localIdentity()),
      source: { capture: async () => jpeg('x') },
      connect: () => {
        attempts++;
        throw new Error('boom');
      },
    });
    uploader.start(DIRECTIVE);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    uploader.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(2);
  });
});

describe('thumbnail uploader against the real hub', () => {
  let app: TestApp;
  let teacher: string;
  let lessonId: string;
  let identity: DeviceIdentity;
  let hub: HubClient | null = null;
  let uploader: ThumbnailUploader | null = null;

  beforeAll(async () => {
    app = await startTestApp();
    const { orgId, siteId } = await seedOrg(app.db.db);
    const roomId = await seedRoom(app.db.db, orgId, siteId, '101');
    await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    teacher = await loginAs(app, 'teacher1');
    const key = generateDeviceKey();
    const deviceId = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId });
    identity = { deviceId, publicKey: key.publicKey, privateKey: createPrivateKey(key.privateKeyPem) };
    lessonId = (await startLesson(app, teacher, roomId)).json.id;
  });
  afterEach(() => {
    uploader?.stop();
    hub?.close();
    uploader = hub = null;
  });
  afterAll(async () => {
    await app?.close();
  });

  async function eventually<T>(check: () => Promise<T | null>, ms = 8_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test('frames reach the hub and the owner reads the latest', async () => {
    const signer = new RequestSigner(identity);
    hub = new HubClient({ origin: app.origin, ca: app.ca, signer });
    let n = 0;
    uploader = new ThumbnailUploader({ hub, signer, source: { capture: async () => jpeg(++n) } });
    uploader.start({ intervalMs: 500, maxWidth: 480 });

    const url = `/api/v1/lessons/${lessonId}/devices/${identity.deviceId}/thumbnail`;
    const read = async (after = 0) => {
      const res = await app.request('GET', url, { cookie: teacher });
      return res.status === 200 && Number(res.headers.get('x-ns-frame-seq')) > after ? res : null;
    };
    const first = await eventually(() => read());
    expect(first.headers.get('content-type')).toBe('image/jpeg');
    expect(first.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(uploader.streaming).toBe(true);

    // Yangi kadr eskisini almashtiradi: hub faqat oxirgisini saqlaydi.
    const later = await eventually(() => read(Number(first.headers.get('x-ns-frame-seq'))));
    expect(later.bytes.toString('latin1')).toMatch(/frame-\d+$/);
    expect(later.bytes.equals(first.bytes)).toBe(false);
  });

  test('stopping ends the stream and no new frames arrive', async () => {
    const signer = new RequestSigner(identity);
    hub = new HubClient({ origin: app.origin, ca: app.ca, signer });
    let n = 0;
    uploader = new ThumbnailUploader({ hub, signer, source: { capture: async () => jpeg(++n) } });
    uploader.start({ intervalMs: 500, maxWidth: 480 });
    await eventually(async () => (n > 0 ? true : null));
    uploader.stop();
    expect(uploader.streaming).toBe(false);
    const captured = n;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(n).toBe(captured);
  });
});
