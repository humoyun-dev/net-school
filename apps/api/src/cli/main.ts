import { readFileSync } from 'node:fs';
import { connectPg } from '../db/client.ts';
import { run } from './run.ts';

const url = process.env.DATABASE_URL_FILE
  ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim()
  : process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL or DATABASE_URL_FILE is required\n');
  process.exit(1);
}
const conn = connectPg(url);
try {
  process.exitCode = await run(process.argv.slice(2), { db: conn.db, driver: 'pg', stdout: process.stdout });
} catch (err) {
  process.stderr.write(`netschool-admin: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await conn.close();
}
