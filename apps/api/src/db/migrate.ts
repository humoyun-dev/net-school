import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Db, DbDriver } from './client.ts';

// Bundle'dan (dist/) ham, manbadan (src/db/) ham topiladi.
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(join('src', 'db')) ? join(here, '..', '..', 'drizzle') : join(here, '..', 'drizzle');
}

export async function migrateDb(db: Db, driver: DbDriver): Promise<void> {
  const config = { migrationsFolder: migrationsFolder() };
  // biome-ignore lint/suspicious/noExplicitAny: ikkala migrator o'z drayver tipini kutadi, Db esa umumiy tip
  if (driver === 'pglite') await migratePglite(db as any, config);
  // biome-ignore lint/suspicious/noExplicitAny: yuqoridagi bilan bir xil sabab
  else await migratePg(db as any, config);
}
