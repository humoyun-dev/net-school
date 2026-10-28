import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { connectPg, type Db, type DbDriver } from '../../src/db/client.ts';
import { migrateDb } from '../../src/db/migrate.ts';
import * as schema from '../../src/db/schema.ts';

export interface TestDb {
  db: Db;
  driver: DbDriver;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const TABLES = 'audit_events, auth_sessions, room_memberships, role_assignments, rooms, users, sites, organizations';

// TEST_DATABASE_URL bo'lsa (CI) real PostgreSQL'da yangi database, aks holda in-process PGlite.
export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const client = new PGlite();
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    await migrateDb(db, 'pglite');
    return {
      db,
      driver: 'pglite',
      reset: async () => {
        await db.execute(sql.raw(`truncate ${TABLES} cascade`));
      },
      close: () => client.close(),
    };
  }

  const name = `ns_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const target = new URL(url);
  target.pathname = `/${name}`;
  const conn = connectPg(target.toString());
  await migrateDb(conn.db, 'pg');
  return {
    db: conn.db,
    driver: 'pg',
    reset: async () => {
      await conn.db.execute(sql.raw(`truncate ${TABLES} cascade`));
    },
    close: async () => {
      await conn.close();
      const drop = new pg.Client({ connectionString: url });
      await drop.connect();
      await drop.query(`drop database if exists ${name}`);
      await drop.end();
    },
  };
}
