// Real MeshCentral protokol javoblarini adapter fixture'lariga yozib oladi.
// Ishga tushirish: pnpm tsx tests/contracts/harness/probe.ts
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { startMeshCentral } from './meshcentral.ts';

type Msg = Record<string, unknown> & { action?: string; event?: Record<string, unknown> };

const fixtures = resolve(import.meta.dirname, '../../../packages/meshcentral-adapter/test/fixtures');

function authHeader(user: string, pass: string): string {
  return `${Buffer.from(user).toString('base64')},${Buffer.from(pass).toString('base64')}`;
}

function open(url: string, ca: string, user: string, pass: string) {
  const ws = new WebSocket(url, { ca, headers: { 'x-meshauth': authHeader(user, pass) } });
  const seen: Msg[] = [];
  const waiters: { match: (m: Msg) => boolean; done: (m: Msg) => void }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    seen.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(msg);
      }
    }
  });
  const waitFor = (match: (m: Msg) => boolean, ms = 15_000) =>
    new Promise<Msg>((done, fail) => {
      const hit = seen.find(match);
      if (hit) return done(hit);
      const timer = setTimeout(() => fail(new Error('timeout waiting for message')), ms);
      waiters.push({
        match,
        done: (m) => {
          clearTimeout(timer);
          done(m);
        },
      });
    });
  const request = (action: string, payload: Record<string, unknown> = {}) => {
    const responseid = randomUUID();
    ws.send(JSON.stringify({ action, ...payload, responseid }));
    return waitFor((m) => m.responseid === responseid);
  };
  const event = (name: string) => waitFor((m) => m.action === 'event' && m.event?.action === name);
  return { ws, seen, waitFor, request, event };
}

const save = (name: string, value: unknown) => writeFile(join(fixtures, name), `${JSON.stringify(value, null, 2)}\n`);

const mc = await startMeshCentral();
try {
  await mkdir(fixtures, { recursive: true });
  const c = open(mc.url, mc.ca, mc.admin.username, mc.admin.password);
  const serverinfo = await c.waitFor((m) => m.action === 'serverinfo');
  console.log('first actions:', c.seen.map((m) => m.action).join(', '), '| serverinfo keys:', Object.keys(serverinfo));

  const created = await c.request('createmesh', { meshname: 'probe', meshtype: 3 });
  console.log('createmesh:', JSON.stringify(created));
  // 'meshes' javobi responseid qaytarmaydi; meshid createmesh javobida bor.
  const mesh = { _id: created.meshid as string };

  const addEvent = c.event('addnode');
  console.log(
    'addlocaldevice:',
    JSON.stringify(
      await c.request('addlocaldevice', { meshid: mesh._id, devicename: 'pc-01', hostname: 'pc-01.lan', type: 4 }),
    ),
  );
  await save('event-addnode.json', await addEvent);

  const nodes = await c.request('nodes');
  await save('nodes.json', nodes);
  const nodeid = Object.values(nodes.nodes as Record<string, { _id: string }[]>)[0]?.[0]?._id;
  if (!nodeid) throw new Error('node not found');

  const changeEvent = c.event('changenode');
  console.log('changedevice:', JSON.stringify(await c.request('changedevice', { nodeid, name: 'pc-01-renamed' })));
  await save('event-changenode.json', await changeEvent);

  const removeEvent = c.event('removenode');
  console.log('removedevices:', JSON.stringify(await c.request('removedevices', { nodeids: [nodeid] })));
  await save('event-removenode.json', await removeEvent);
  c.ws.close();

  // Noto'g'ri parol: server nima qiladi?
  const bad = open(mc.url, mc.ca, mc.admin.username, 'wrong-password');
  const outcome = await new Promise<string>((done) => {
    bad.ws.on('unexpected-response', (_req, res) => done(`HTTP ${res.statusCode} (upgrade rad etildi)`));
    bad.ws.on('close', (code, reason) =>
      done(`close code=${code} reason=${String(reason)} messages=${JSON.stringify(bad.seen)}`),
    );
    bad.ws.on('error', (err) => done(`error ${err.message}`));
  });
  await writeFile(
    join(fixtures, 'auth-failure.md'),
    `# Noto'g'ri parol bilan control.ashx\n\nMeshCentral adce1ec (probe.ts tomonidan yozilgan):\n\n\`\`\`\n${outcome}\n\`\`\`\n`,
  );
  console.log('auth failure:', outcome);
} finally {
  await mc.stop();
}
