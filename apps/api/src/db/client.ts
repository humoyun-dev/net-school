import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

// pg va PGlite drayverlari uchun umumiy tip.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type DbDriver = 'pg' | 'pglite';
export const DB = Symbol('DB');

export function connectPg(url: string): { db: Db; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }) as unknown as Db, close: () => pool.end() };
}
