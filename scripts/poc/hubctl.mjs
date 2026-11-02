// PoC: admin sahifalari (P1f2) bo'lmaguncha hub'ni API orqali boshqarish.
//   NETSCHOOL_PASSWORD=… node scripts/poc/hubctl.mjs --origin https://hub --ca hub-ca.pem --user admin <buyruq>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectHub } from './hub-client.mjs';

const USAGE = `buyruqlar:
  room create <nom> --site <bino>
  enrollment create --room <xona>
  mesh nodes --site <bino>
  mesh bind <hostname> <nodeId>
  teacher create <username> --room <xona> --password <kamida 12 belgi>
  lesson start --room <xona>`;

async function sites(c) {
  return (await c.get('/api/v1/sites')).sites;
}
async function siteByName(c, name) {
  const all = await sites(c);
  const site = name ? all.find((s) => s.name === name) : all[0];
  if (!site) throw new Error(`site not found: ${name ?? '(none)'}`);
  return site;
}
async function roomByName(c, name) {
  for (const site of await sites(c)) {
    const room = (await c.get(`/api/v1/sites/${site.id}/rooms`)).rooms.find((r) => r.name === name);
    if (room) return room;
  }
  throw new Error(`room not found: ${name}`);
}
async function deviceByHostname(c, hostname) {
  for (const site of await sites(c)) {
    const device = (await c.get(`/api/v1/sites/${site.id}/devices`)).devices.find((d) => d.hostname === hostname);
    if (device) return device;
  }
  throw new Error(`device not found: ${hostname}`);
}

export async function hubctl(c, argv, print = console.log) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { site: { type: 'string' }, room: { type: 'string' }, password: { type: 'string' } },
    allowPositionals: true,
  });
  const [group, action, ...rest] = positionals;
  const cmd = `${group} ${action}`;
  if (cmd === 'room create') {
    const site = await siteByName(c, values.site);
    const room = await c.send('POST', `/api/v1/sites/${site.id}/rooms`, { name: rest[0] });
    print(`room: ${room.name} ${room.id}`);
  } else if (cmd === 'enrollment create') {
    const room = await roomByName(c, values.room);
    const e = await c.send('POST', '/api/v1/enrollments', {
      siteId: room.siteId,
      roomId: room.id,
      expiresInMinutes: 120,
    });
    print(`token: ${e.token}\nexpires: ${e.expiresAt}\n(token faqat shu yerda ko'rsatiladi)`);
  } else if (cmd === 'mesh nodes') {
    const site = await siteByName(c, values.site);
    for (const n of (await c.get(`/api/v1/sites/${site.id}/mesh-nodes`)).nodes) {
      print(`${n.meshNodeId}\t${n.name}\t${n.agentOnline ? 'online' : 'offline'}\t${n.boundDeviceId ?? '-'}`);
    }
  } else if (cmd === 'mesh bind') {
    const device = await deviceByHostname(c, rest[0]);
    await c.send('PUT', `/api/v1/devices/${device.id}/mesh-binding`, { meshNodeId: rest[1] });
    print(`bound: ${device.hostname} → ${rest[1]}`);
  } else if (cmd === 'teacher create') {
    const room = await roomByName(c, values.room);
    if (!values.password || values.password.length < 12) throw new Error('--password must be at least 12 characters');
    const user = await c.send('POST', '/api/v1/users', {
      username: rest[0],
      displayName: rest[0],
      password: values.password,
      roles: [{ role: 'teacher', siteId: room.siteId }],
    });
    await c.send('PUT', `/api/v1/rooms/${room.id}/teachers/${user.id}`);
    print(`teacher: ${user.username} (${room.name})`);
  } else if (cmd === 'lesson start') {
    const room = await roomByName(c, values.room);
    const lesson = await c.send('POST', `/api/v1/rooms/${room.id}/lessons`, { title: 'PoC' });
    print(`lesson: ${lesson.id}`);
  } else {
    throw new Error(USAGE);
  }
}

export function cliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { origin: { type: 'string' }, ca: { type: 'string' }, user: { type: 'string' } },
    allowPositionals: true,
    strict: false,
  });
  const password = process.env.NETSCHOOL_PASSWORD;
  if (!values.origin || !values.user || !password) {
    throw new Error('--origin, --user and NETSCHOOL_PASSWORD are required (--ca for a private hub CA)');
  }
  return {
    hub: {
      origin: values.origin,
      ca: values.ca ? readFileSync(values.ca) : undefined,
      username: values.user,
      password,
    },
    rest: argv.filter(
      (a, i) => !['--origin', '--ca', '--user'].includes(a) && !['--origin', '--ca', '--user'].includes(argv[i - 1]),
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { hub, rest } = cliOptions(process.argv.slice(2));
    await hubctl(await connectHub(hub), rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
