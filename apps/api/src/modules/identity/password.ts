import { randomBytes, type ScryptOptions, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const OPTIONS: ScryptOptions = { N, r: R, p: P, maxmem: 64 * 1024 * 1024 };
const PREFIX = `scrypt$${N}$${R}$${P}$`;

function derive(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(plain, salt, KEY_LENGTH, OPTIONS, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(plain, salt);
  return `${PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Faqat aniq pin qilingan parametrlar qabul qilinadi: begona N bilan CPU/xotira hujumi bo'lmaydi.
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(PREFIX)) return false;
  const [saltText, keyText, ...rest] = stored.slice(PREFIX.length).split('$');
  if (!saltText || !keyText || rest.length > 0) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(keyText, 'base64url');
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(plain, salt);
  return timingSafeEqual(actual, expected);
}

// Noma'lum foydalanuvchi uchun ham bir xil scrypt ishi bajariladi (vaqt orqali oshkor bo'lmasin).
export const DUMMY_HASH = `${PREFIX}${Buffer.alloc(SALT_LENGTH, 7).toString('base64url')}$${scryptSync(
  'dummy',
  Buffer.alloc(SALT_LENGTH, 7),
  KEY_LENGTH,
  OPTIONS,
).toString('base64url')}`;
