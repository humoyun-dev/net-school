import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { auditEvents, organizations } from '../src/db/schema.ts';
import { AuditWriter } from '../src/modules/audit/audit.writer.ts';
import { createTestDb, type TestDb } from './support/db.ts';

let t: TestDb;
const writer = new AuditWriter();

beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => {
  await t.reset();
});
afterAll(async () => {
  await t?.close();
});

test("audit entry is written inside the caller's transaction and rolled back with it", async () => {
  await expect(
    t.db.transaction(async (tx) => {
      await writer.write(
        tx,
        { organizationId: null, actorUserId: null, action: 'auth.login', result: 'failed' },
        'corr-1',
      );
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await t.db.select().from(auditEvents)).toHaveLength(0);

  await t.db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'o' }).returning();
    await writer.write(
      tx,
      {
        organizationId: org?.id ?? null,
        actorUserId: null,
        action: 'site.create',
        targetType: 'site',
        targetId: 'x',
        result: 'succeeded',
      },
      'corr-2',
    );
  });
  const rows = await t.db.select().from(auditEvents).where(eq(auditEvents.correlationId, 'corr-2'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'site.create', targetType: 'site', targetId: 'x', result: 'succeeded' });
});

test('oversized details are replaced with a truncation marker', async () => {
  await writer.write(
    t.db,
    {
      organizationId: null,
      actorUserId: null,
      action: 'auth.login',
      result: 'failed',
      details: { blob: 'x'.repeat(5000) },
    },
    'corr-3',
  );
  const [row] = await t.db.select().from(auditEvents);
  expect(row?.details).toEqual({ truncated: true });
});

test('details never contain keys password, token, cookie', async () => {
  await writer.write(
    t.db,
    {
      organizationId: null,
      actorUserId: null,
      action: 'auth.login',
      result: 'failed',
      details: { reason: 'bad_credentials', password: 'p', Token: 't', nested: { sessionCookie: 'c', ok: 1 } },
    },
    'corr-4',
  );
  const [row] = await t.db.select().from(auditEvents);
  expect(row?.details).toEqual({ reason: 'bad_credentials', nested: { ok: 1 } });
});
