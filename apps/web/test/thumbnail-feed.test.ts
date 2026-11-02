import { describe, expect, test } from 'vitest';
import { ThumbnailFeed } from '../src/classroom/thumbnail-feed.ts';

const DEVICE = '00000000-0000-4000-8000-000000000010';
const OTHER = '00000000-0000-4000-8000-000000000099';

class FakeSocket {
  static last: FakeSocket | null = null;
  binaryType = 'blob';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  frame(deviceId: string, byte: number) {
    const id = Uint8Array.from(Buffer.from(deviceId.replace(/-/g, ''), 'hex'));
    const data = new Uint8Array(16 + 4);
    data.set(id, 0);
    data.set([0xff, 0xd8, 0xff, byte], 16);
    this.onmessage?.({ data: data.buffer });
  }
}

function fakeUrl() {
  const live = new Set<string>();
  let n = 0;
  return {
    live,
    createObjectURL: () => {
      n += 1;
      const url = `blob:${n}`;
      live.add(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      live.delete(url);
    },
  };
}

describe('thumbnail feed', () => {
  test('replacing a frame revokes the previous object URL', () => {
    const urls = fakeUrl();
    const seen: [string, string][] = [];
    const feed = new ThumbnailFeed('wss://hub/api/v1/lessons/x/thumbnails/stream', (d, u) => seen.push([d, u]), {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      URL: urls,
      accept: () => true,
    });
    for (let i = 0; i < 100; i++) FakeSocket.last?.frame(DEVICE, i);
    expect(seen).toHaveLength(100);
    expect(urls.live.size).toBe(1);
    expect(FakeSocket.last?.binaryType).toBe('arraybuffer');
    feed.close();
    expect(urls.live.size).toBe(0);
    expect(FakeSocket.last?.closed).toBe(true);
  });

  test('frames for a device not in the lesson are ignored', () => {
    const urls = fakeUrl();
    const seen: string[] = [];
    const feed = new ThumbnailFeed('wss://hub/x', (d) => seen.push(d), {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      URL: urls,
      accept: (d) => d === DEVICE,
    });
    FakeSocket.last?.frame(OTHER, 1);
    FakeSocket.last?.frame(DEVICE, 2);
    expect(seen).toEqual([DEVICE]);
    expect(urls.live.size).toBe(1);
    feed.close();
  });

  test('a 4401 close reports sign-out and does not reconnect; 4410 stops', () => {
    const urls = fakeUrl();
    const events: string[] = [];
    const feed = new ThumbnailFeed('wss://hub/x', () => {}, {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      URL: urls,
      accept: () => true,
      onUnauthenticated: () => events.push('signed-out'),
      onEnded: () => events.push('ended'),
    });
    const first = FakeSocket.last;
    first?.onclose?.({ code: 4401 });
    expect(events).toEqual(['signed-out']);
    expect(FakeSocket.last).toBe(first);
    feed.close();
  });
});
