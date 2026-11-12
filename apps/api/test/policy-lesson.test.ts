import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { endLesson, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let app: TestApp;
let roomId: string;
let otherRoomId: string;
let teacher: string;

beforeAll(async () => {
  app = await startTestApp({});
});
beforeEach(async () => {
  await app.db.reset();
  const { orgId, siteId } = await seedOrg(app.db.db);
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [otherRoomId] });
  await seedUser(app.db.db, orgId, 'siteadmin', [{ role: 'school_admin', siteId }]);
  await seedUser(app.db.db, orgId, 'student1', [{ role: 'student', siteId }]);
  teacher = await loginAs(app, 'teacher1');
});
afterAll(async () => {
  await app?.close();
});

const web = (mode: string, patterns: string[] = []) => ({ schemaVersion: 1, web: { mode, patterns } });
const put = (lessonId: string, body: unknown, ifMatch: string, cookie = teacher) =>
  app.request('PUT', `/api/v1/lessons/${lessonId}/policy`, { body, cookie, headers: { 'if-match': ifMatch } });
async function lesson(cookie = teacher, room = roomId) {
  const res = await startLesson(app, cookie, room);
  expect(res.status).toBe(201);
  return res.json.id as string;
}

describe('lesson policy', () => {
  test('lesson owner sets web allowlist', async () => {
    const id = await lesson();
    const v1 = await put(id, web('allowlist', ['Docs.Example.com']), '0');
    expect(v1.status, JSON.stringify(v1.json)).toBe(201);
    expect(v1.json).toMatchObject({ layer: 'lesson', lessonId: id, version: 1 });
    expect(v1.json.document.web.patterns).toEqual(['docs.example.com']);
    expect((await put(id, web('blocklist', ['game.com']), '1')).json.version).toBe(2);
    const got = await app.request('GET', `/api/v1/lessons/${id}/policy`, { cookie: teacher });
    expect(got.json.current.version).toBe(2);
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'policy.lesson_changed'));
    expect(audit?.targetType).toBe('policy_version');
  });

  test('other teacher and student are denied, site admin is allowed', async () => {
    const id = await lesson();
    const other = await put(id, web('off'), '0', await loginAs(app, 'teacher2'));
    expect(other.status).toBe(403);
    expect((await put(id, web('off'), '0', await loginAs(app, 'student1'))).status).toBe(403);
    expect((await put(id, web('off'), '0', await loginAs(app, 'siteadmin'))).status).toBe(201);
    const read = await app.request('GET', `/api/v1/lessons/${id}/policy`, { cookie: await loginAs(app, 'teacher2') });
    expect(read.status).toBe(403);
  });

  test('ended lesson rejects policy changes', async () => {
    const id = await lesson();
    expect((await endLesson(app, teacher, id)).status).toBe(200);
    const res = await put(id, web('off'), '0');
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
  });

  test('lesson version numbering is per lesson', async () => {
    const first = await lesson();
    await put(first, web('off'), '0');
    await endLesson(app, teacher, first);
    const second = await lesson();
    expect((await put(second, web('allowlist'), '0')).json.version).toBe(1);
  });

  test('unknown lesson is denied like a foreign one', async () => {
    expect((await put('00000000-0000-4000-8000-000000000000', web('off'), '0')).status).toBe(403);
  });
});
