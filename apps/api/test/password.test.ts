import { expect, test } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/identity/password.ts';

test('hash uses the pinned scrypt format', async () => {
  const stored = await hashPassword('correct horse battery');
  expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  expect(await hashPassword('correct horse battery')).not.toBe(stored);
});

test('verify accepts the right password and rejects others', async () => {
  const stored = await hashPassword('correct horse battery');
  expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
  expect(await verifyPassword('', stored)).toBe(false);
});

test('verify rejects malformed stored hashes without throwing', async () => {
  for (const bad of [
    '',
    'x',
    'scrypt$1$8$1$aa$bb',
    'scrypt$32768$8$1$$',
    'bcrypt$whatever',
    'scrypt$999999999$8$1$aa$bb',
  ]) {
    expect(await verifyPassword('pw', bad)).toBe(false);
  }
});
