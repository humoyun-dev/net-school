// PoC avtomatik tekshiruvi: hub API orqali haqiqiy kompyuter zanjirini tekshiradi va JSON dalil yozadi.
//   NETSCHOOL_PASSWORD=… node scripts/poc/verify.mjs --origin https://hub --ca hub-ca.pem --user admin \
//     --room Lab-1 --agent-host hub.school.lan:4433 --out docs/poc/results/windows-<sana>.json [--power reboot]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectHub } from './hub-client.mjs';
import { cliOptions } from './hubctl.mjs';

const POLL_MS = 500;
// Bitta namunada server `Date` headeri 1 s aniqlikda: p95 ≤2 s maqsadiga +1 s yaxlitlash qo'shiladi.
const THUMBNAIL_MAX_AGE_MS = 3_000;
const FINISHED = ['succeeded', 'failed', 'expired', 'cancelled'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what}: timed out after ${Math.round(timeoutMs / 1000)} s`);
    await sleep(POLL_MS);
  }
}

async function findRoom(c, name) {
  for (const site of (await c.get('/api/v1/sites')).sites) {
    const room = (await c.get(`/api/v1/sites/${site.id}/rooms`)).rooms.find((r) => r.name === name);
    if (room) return room;
  }
  throw new Error(`room not found: ${name}`);
}

export async function verify(c, opts) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const report = { startedAt: new Date().toISOString(), hub: c.origin, room: opts.room, device: null, steps: [] };
  const step = async (id, title, fn) => {
    try {
      const evidence = await fn();
      report.steps.push({ id, title, status: 'passed', evidence: evidence ?? {} });
      return evidence;
    } catch (err) {
      report.steps.push({
        id,
        title,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        evidence: {},
      });
      return null;
    }
  };

  let lessonId = null;
  const room = await findRoom(c, opts.room);
  // Qurilma onlayn bo'lmasa ham topiladi (masalan `--power wake` o'chiq kompyuterda).
  const found = await step('device_found', 'Qurilma xonada', async () => {
    const devices = (await c.get(`/api/v1/rooms/${room.id}/devices`)).devices;
    const dev = opts.hostname ? devices.find((x) => x.hostname === opts.hostname) : devices[0];
    if (!dev) throw new Error(`no device in room ${room.name}`);
    report.device = { id: dev.id, hostname: dev.hostname };
    return { deviceId: dev.id, hostname: dev.hostname, _device: dev };
  });
  const d = found?._device ?? null;
  if (found) delete found._device;
  if (opts.power) return finish(await powerStep(c, report, step, d, opts));

  await step('device_enrolled', "Companion ro'yxatdan o'tgan va onlayn", async () => {
    if (!d) throw new Error('no device');
    if (d.companion.presence !== 'online') throw new Error(`Companion is ${d.companion.presence}`);
    return { lastHeartbeatAt: d.companion.lastHeartbeatAt };
  });

  await step('capabilities', 'Capability hisoboti', async () => {
    if (!d) throw new Error('no device');
    const caps = d.capabilities?.capabilities ?? {};
    for (const name of ['classroom.message', 'classroom.overlay', 'classroom.help']) {
      if (caps[name]?.state !== 'available') throw new Error(`${name} is ${caps[name]?.state ?? 'missing'}`);
    }
    return { os: d.capabilities?.os, desktopSession: d.capabilities?.desktopSession, capabilities: caps };
  });

  await step('agent_bound', "MeshAgent bog'langan va onlayn", async () => {
    if (!d) throw new Error('no device');
    if (d.agent !== 'online') {
      const target = opts.agentHost ?? '<MESH_AGENT_HOST>:4433';
      const [host, port = '4433'] = target.split(':');
      throw new Error(
        `MeshAgent is ${d.agent}; the agent must reach ${target}. On Windows: Test-NetConnection ${host} -Port ${port}` +
          (d.agent === 'unbound' ? '; then bind it: hubctl mesh nodes / mesh bind' : ''),
      );
    }
    return { agent: d.agent };
  });

  const lesson = async () => {
    if (lessonId) return lessonId;
    const active = (await c.get(`/api/v1/rooms/${room.id}/lessons/active`)).lesson;
    lessonId = active?.id ?? (await c.send('POST', `/api/v1/rooms/${room.id}/lessons`, { title: 'PoC verify' })).id;
    return lessonId;
  };
  const command = async (body) => {
    const id = await lesson();
    const created = await c.send('POST', `/api/v1/lessons/${id}/commands`, { ...body, targetDeviceIds: [d.id] });
    const done = await until(
      async () => {
        const cmd = await c.get(`/api/v1/commands/${created.id}`);
        const t = cmd.targets.find((x) => x.deviceId === d.id);
        return t && FINISHED.includes(t.status) ? t : null;
      },
      timeoutMs,
      body.type,
    );
    if (done.status !== 'succeeded') throw new Error(`${body.type}: target ${done.status} (${done.reason ?? '-'})`);
    return { commandId: created.id, status: done.status };
  };

  await step('message', 'Xabar yetkazildi', async () => {
    if (!d) throw new Error('no device');
    return command({ type: 'message.show', payload: { text: 'NetSchool PoC: xabar sinovi' } });
  });
  await step('overlay', 'Bloklash va ochish', async () => {
    if (!d) throw new Error('no device');
    let unlocked = false;
    try {
      const lock = await command({ type: 'overlay.lock', payload: { message: 'PoC' } });
      const unlock = await command({ type: 'overlay.unlock', payload: {} });
      unlocked = true;
      return { lock, unlock };
    } finally {
      // O'quvchi ekrani qulflangan holda qolmasin (lease 120 s kutilmaydi).
      if (!unlocked) await command({ type: 'overlay.unlock', payload: {} }).catch(() => {});
    }
  });
  await step('thumbnail', 'Miniatura (oxirgi kadr ≤2 s)', async () => {
    if (!d) throw new Error('no device');
    const id = await lesson();
    const res = await until(
      async () => {
        const r = await c.raw('GET', `/api/v1/lessons/${id}/devices/${d.id}/thumbnail`);
        return r.status === 200 ? r : null;
      },
      timeoutMs,
      'thumbnail',
    );
    const frameAt = Date.parse(String(res.headers['x-ns-frame-at']));
    const ageMs = Date.parse(String(res.headers.date)) - frameAt;
    // Header yo'q yoki noto'g'ri bo'lsa ageMs NaN: bu ham muvaffaqiyatsizlik.
    if (!(ageMs <= THUMBNAIL_MAX_AGE_MS)) throw new Error(`latest frame age is ${ageMs} ms`);
    return { bytes: res.raw.length, contentType: res.headers['content-type'], ageMs };
  });
  await step('remote', "Ko'rish, boshqarish, control_busy va yopish", async () => {
    if (!d) throw new Error('no device');
    const id = await lesson();
    const opened = [];
    const open = async (mode) => {
      const s = await c.send('POST', `/api/v1/lessons/${id}/remote-sessions`, { deviceId: d.id, mode });
      opened.push(s.id);
      return s;
    };
    try {
      const view = await open('view');
      const ticket = await c.send('POST', `/api/v1/remote-sessions/${view.id}/ticket`);
      await c.send('DELETE', `/api/v1/remote-sessions/${view.id}`);
      const control = await open('control');
      const second = await c.raw('POST', `/api/v1/lessons/${id}/remote-sessions`, { deviceId: d.id, mode: 'control' });
      if (second.status !== 409 || second.json?.error?.code !== 'control_busy') {
        throw new Error(`a second control session was not refused (HTTP ${second.status})`);
      }
      await c.send('DELETE', `/api/v1/remote-sessions/${control.id}`);
      const closed = await c.get(`/api/v1/remote-sessions/${control.id}`);
      if (closed.status !== 'closed') throw new Error(`control session is ${closed.status} after DELETE`);
      return {
        viewSession: view.id,
        ticketHost: new URL(ticket.url).host,
        controlSession: control.id,
        secondControl: 409,
      };
    } finally {
      // Xato bo'lsa ham remote principal'lar ochiq qolmaydi (ADR 0003); DELETE idempotent.
      for (const sid of opened) await c.send('DELETE', `/api/v1/remote-sessions/${sid}`).catch(() => {});
    }
  });

  return finish(report);

  function finish(r) {
    r.finishedAt = new Date().toISOString();
    r.lessonId = lessonId;
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, `${JSON.stringify(r, null, 2)}\n`);
    }
    return r;
  }
}

async function powerStep(c, report, step, d, opts) {
  await step(`power_${opts.power}`, `Quvvat: ${opts.power}`, async () => {
    if (!d) throw new Error('no device');
    const action = await c.send('POST', '/api/v1/power-actions', {
      type: opts.power,
      scope: { kind: 'devices', deviceIds: [d.id] },
    });
    const done = await until(
      async () => {
        const a = await c.get(`/api/v1/power-actions/${action.id}`);
        return a.status === 'completed' ? a : null;
      },
      opts.powerTimeoutMs ?? 12 * 60_000,
      `power ${opts.power}`,
    );
    const t = done.targets?.[0];
    if (t?.status !== 'succeeded') throw new Error(`power ${opts.power}: target ${t?.status} (${t?.reason ?? '-'})`);
    return { actionId: action.id, status: t.status };
  });
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { hub, rest } = cliOptions(process.argv.slice(2));
    const { values } = parseArgs({
      args: rest,
      options: {
        room: { type: 'string' },
        hostname: { type: 'string' },
        out: { type: 'string' },
        power: { type: 'string' },
        'agent-host': { type: 'string' },
      },
    });
    if (!values.room) throw new Error('--room is required');
    if (values.power && !['shutdown', 'reboot', 'sleep', 'wake'].includes(values.power)) {
      throw new Error('--power must be shutdown, reboot, sleep or wake');
    }
    const report = await verify(await connectHub(hub), {
      room: values.room,
      hostname: values.hostname,
      out: values.out,
      power: values.power,
      agentHost: values['agent-host'],
    });
    for (const s of report.steps) console.log(`${s.status === 'passed' ? 'PASS' : 'FAIL'}  ${s.id}  ${s.error ?? ''}`);
    if (values.out) console.log(`evidence: ${values.out}`);
    process.exitCode = report.steps.every((s) => s.status === 'passed') ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
