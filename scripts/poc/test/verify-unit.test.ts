import { describe, expect, test } from 'vitest';
import { cliOptions } from '../hubctl.mjs';
import { verify } from '../verify.mjs';

const DEVICE = {
  id: 'd1',
  hostname: 'WIN-PC-01',
  companion: { presence: 'online', lastHeartbeatAt: null },
  agent: 'online',
  capabilities: {
    capabilities: {
      'classroom.message': { state: 'available' },
      'classroom.overlay': { state: 'available' },
      'classroom.help': { state: 'available' },
    },
  },
};

// Hub API'ning soxtasi: har yo'l uchun javob, chaqiruvlar yoziladi.
function fakeHub(over: { device?: object; ticketFails?: boolean; unlockFails?: boolean; frameHeaders?: object } = {}) {
  const calls: string[] = [];
  const device = { ...DEVICE, ...over.device };
  let cmd = 0;
  const commands = new Map<string, string>();
  const c = {
    origin: 'https://hub',
    async get(path: string) {
      calls.push(`GET ${path}`);
      if (path === '/api/v1/sites') return { sites: [{ id: 's1', name: 'Bino' }] };
      if (path === '/api/v1/sites/s1/rooms') return { rooms: [{ id: 'r1', siteId: 's1', name: 'Lab-1' }] };
      if (path === '/api/v1/rooms/r1/devices') return { devices: [device] };
      if (path === '/api/v1/rooms/r1/lessons/active') return { lesson: { id: 'l1' } };
      if (path.startsWith('/api/v1/commands/')) {
        const id = path.split('/').at(-1) as string;
        return { targets: [{ deviceId: 'd1', status: commands.get(id), reason: null }] };
      }
      if (path.startsWith('/api/v1/remote-sessions/')) return { status: 'closed' };
      if (path.startsWith('/api/v1/power-actions/')) return { status: 'completed', targets: [{ status: 'succeeded' }] };
      throw new Error(`unexpected GET ${path}`);
    },
    async send(method: string, path: string, body?: { type?: string; mode?: string }) {
      calls.push(`${method} ${path}${body?.type ? ` ${body.type}` : ''}${body?.mode ? ` ${body.mode}` : ''}`);
      if (path.endsWith('/commands')) {
        const id = `c${++cmd}`;
        commands.set(id, over.unlockFails && body?.type === 'overlay.unlock' ? 'failed' : 'succeeded');
        return { id };
      }
      if (path.endsWith('/remote-sessions')) return { id: `rs-${body?.mode}` };
      if (path.endsWith('/ticket')) {
        if (over.ticketFails) throw new Error('409 conflict');
        return { url: 'https://hub:8444/rs/redeem?ticket=t' };
      }
      if (path === '/api/v1/power-actions') return { id: 'p1' };
      return null;
    },
    async raw(method: string, path: string) {
      calls.push(`${method} ${path} (raw)`);
      if (path.endsWith('/thumbnail')) {
        return {
          status: 200,
          raw: Buffer.from([0xff, 0xd8]),
          headers: over.frameHeaders ?? {
            'content-type': 'image/jpeg',
            date: new Date().toUTCString(),
            'x-ns-frame-at': new Date().toISOString(),
          },
        };
      }
      return { status: 409, json: { error: { code: 'control_busy' } } };
    },
  };
  return { c, calls };
}

const statusOf = (report: { steps: { id: string; status: string; error?: string }[] }, id: string) =>
  report.steps.find((s) => s.id === id);

describe('verify safety', () => {
  test('a failed ticket still closes the remote session', async () => {
    const { c, calls } = fakeHub({ ticketFails: true });
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 1_000 });
    expect(statusOf(report, 'remote')?.status).toBe('failed');
    expect(calls).toContain('DELETE /api/v1/remote-sessions/rs-view');
  });

  test('a failed unlock is retried once in cleanup and the step fails', async () => {
    const { c, calls } = fakeHub({ unlockFails: true });
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 1_000 });
    expect(statusOf(report, 'overlay')?.status).toBe('failed');
    expect(calls.filter((x) => x.endsWith('overlay.unlock'))).toHaveLength(2);
  });

  test('a frame without a timestamp does not pass the thumbnail check', async () => {
    const { c } = fakeHub({ frameHeaders: { 'content-type': 'image/jpeg', date: new Date().toUTCString() } });
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 1_000 });
    expect(statusOf(report, 'thumbnail')?.status).toBe('failed');
  });

  test('a power run works with the computer off and skips the interactive steps', async () => {
    const { c, calls } = fakeHub({
      device: { companion: { presence: 'stale', lastHeartbeatAt: null }, agent: 'offline' },
    });
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 1_000, power: 'wake' });
    expect(report.steps.map((s: { id: string }) => s.id)).toEqual(['device_found', 'power_wake']);
    expect(statusOf(report, 'power_wake')?.status).toBe('passed');
    expect(calls.some((x) => x.includes('/commands'))).toBe(false);
  });
});

describe('cli options', () => {
  test('origin, CA and user can come from the environment', () => {
    const env = {
      NETSCHOOL_HUB_ORIGIN: 'https://hub',
      NETSCHOOL_HUB_USER: 'admin',
      NETSCHOOL_PASSWORD: 'x'.repeat(12),
    };
    const { hub, rest } = cliOptions(['room', 'create', 'Lab-1'], env);
    expect(hub).toMatchObject({ origin: 'https://hub', username: 'admin' });
    expect(rest).toEqual(['room', 'create', 'Lab-1']);
    expect(() => cliOptions(['x'], {})).toThrow(/NETSCHOOL_HUB_ORIGIN/);
  });
});
