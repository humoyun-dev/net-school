import { readFileSync } from 'node:fs';
import { connectPg } from '../db/client.ts';
import { meshAgentSource } from './mesh-source.ts';
import { run } from './run.ts';

const url = process.env.DATABASE_URL_FILE
  ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim()
  : process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL or DATABASE_URL_FILE is required\n');
  process.exit(1);
}
// MeshCentral ixtiyoriy: faqat mesh-agent-installer uchun (MESHCENTRAL_* — API bilan bir xil o'zgaruvchilar).
const file = (name: string) =>
  process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`] as string, 'utf8').trim() : process.env[name];
const meshUrl = process.env.MESHCENTRAL_URL;
const mesh =
  meshUrl && file('MESHCENTRAL_USERNAME') && file('MESHCENTRAL_PASSWORD') && file('MESHCENTRAL_CA')
    ? meshAgentSource({
        url: meshUrl,
        username: file('MESHCENTRAL_USERNAME') as string,
        password: file('MESHCENTRAL_PASSWORD') as string,
        ca: file('MESHCENTRAL_CA') as string,
      })
    : null;
const conn = connectPg(url);
try {
  process.exitCode = await run(process.argv.slice(2), {
    db: conn.db,
    driver: 'pg',
    stdout: process.stdout,
    meshAgents: mesh,
  });
} catch (err) {
  process.stderr.write(`netschool-admin: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await conn.close();
}
