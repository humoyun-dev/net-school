import { request } from 'node:https';
import { AdapterError } from '../errors.ts';
import { CookieJar } from './cookie-jar.ts';

export interface UpstreamEndpoint {
  origin: string; // 'https://localhost:<port>'
  ca: string | Buffer; // majburiy; tizim CA'lari bilan almashtirilmaydi
  servername?: string; // default: origin hostname
}

interface Reply {
  status: number;
  setCookie: string[];
  body: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TLS_ERROR = /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/;
const AUTH_COOKIE = /var authCookie = '([^']+)';/;

// Faqat berilgan CA bilan TLS; redirect kuzatilmaydi, javob hajmi cheklangan.
function send(
  ep: UpstreamEndpoint,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  const url = new URL(path, ep.origin);
  return new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        ca: ep.ca,
        servername: ep.servername ?? url.hostname,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new AdapterError('invalid_upstream_message', 'Upstream response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            setCookie: res.headers['set-cookie'] ?? [],
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => reject(toAdapterError(err)));
      },
    );
    req.on('timeout', () => req.destroy(new AdapterError('upstream_timeout', 'MeshCentral did not answer in time')));
    req.on('error', (err) => reject(toAdapterError(err)));
    req.end(body);
  });
}

function toAdapterError(err: Error & { code?: string }): AdapterError {
  if (err instanceof AdapterError) return err;
  if (TLS_ERROR.test(err.code ?? '')) {
    return new AdapterError('upstream_tls_failed', `TLS verification failed: ${err.code}`);
  }
  return new AdapterError('upstream_unavailable', err.message);
}

// Server tomonida principal login: POST /login, so'ng GET / da real authCookie borligi tekshiriladi.
// `clientIp` cookieIpCheck uchun sessiyani brauzer IP'siga bog'laydi (X-Forwarded-For).
export async function loginPrincipal(
  ep: UpstreamEndpoint,
  creds: { username: string; password: string },
  clientIp: string,
): Promise<CookieJar> {
  const jar = new CookieJar();
  const form = new URLSearchParams({ action: 'login', username: creds.username, password: creds.password }).toString();
  const login = await send(
    ep,
    'POST',
    '/login',
    {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(form)),
      'x-forwarded-for': clientIp,
    },
    form,
  );
  jar.absorb(login.setCookie);

  const root = await send(ep, 'GET', '/', { cookie: jar.header(), 'x-forwarded-for': clientIp });
  jar.absorb(root.setCookie);
  if (root.status !== 200 || !AUTH_COOKIE.test(root.body)) {
    throw new AdapterError('upstream_auth_failed', 'MeshCentral rejected the principal login');
  }
  return jar;
}
