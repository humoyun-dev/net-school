// PoC skriptlari uchun minimal hub klienti: cookie sessiya, aniq Origin, Idempotency-Key, hub CA bilan TLS
// (tekshiruv o'chirilmaydi).
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';

export class HubError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

function call(origin, ca, method, path, { body, cookie, key } = {}) {
  const url = new URL(path, origin);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { accept: 'application/json', origin };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (key) headers['idempotency-key'] = key;
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, ca, timeout: 60_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const type = res.headers['content-type'] ?? '';
        let json;
        if (type.includes('application/json') && raw.length > 0) json = JSON.parse(raw.toString('utf8'));
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, raw });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function connectHub({ origin, ca, username, password }) {
  const login = await call(origin, ca, 'POST', '/api/v1/auth/login', { body: { username, password } });
  if (login.status !== 200) throw new HubError(login.status, login.json?.error?.code ?? 'login_failed', 'login failed');
  const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0];
  if (login.json?.user?.mustChangePassword) throw new Error('change the password in the panel first');
  const ok = (res) => {
    if (res.status >= 400) {
      throw new HubError(res.status, res.json?.error?.code ?? 'error', res.json?.error?.message ?? 'request failed');
    }
    return res;
  };
  return {
    origin,
    async get(path) {
      return ok(await call(origin, ca, 'GET', path, { cookie })).json;
    },
    async raw(method, path, body) {
      return call(origin, ca, method, path, { cookie, body, key: method === 'POST' ? randomUUID() : undefined });
    },
    async send(method, path, body) {
      return ok(await call(origin, ca, method, path, { cookie, body, key: randomUUID() })).json;
    },
  };
}
