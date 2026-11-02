import { Agent, type RequestOptions, request } from 'node:https';
import type { z } from 'zod';
import type { RequestSigner } from './identity.ts';

export type HubErrorKind = 'tls' | 'network' | 'timeout' | 'http';

export class HubError extends Error {
  readonly kind: HubErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(kind: HubErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'HubError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export interface JsonOptions {
  // `control` — ketma-ket (imzo tartibi buzilmasin); `poll` — uzoq long-poll alohida, control'ni to'smaydi.
  lane?: 'control' | 'poll';
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RETRY_DELAY_MS = 50;
// Node/OpenSSL sertifikat va TLS xatolarining kodlari: ularning hammasi fail-closed (qayta urinib ishonch yumshatilmaydi).
const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT)|HOSTNAME_MISMATCH$)/;

function parseOrigin(origin: string): URL {
  const url = URL.canParse(origin) ? new URL(origin) : null;
  if (url?.protocol !== 'https:' || url.origin !== origin) {
    throw new Error('hub origin must be a bare https origin (https://host[:port])');
  }
  return url;
}

function toHubError(err: unknown): HubError {
  if (err instanceof HubError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? null;
  const message = err instanceof Error ? err.message : String(err);
  if (code && TLS_CODE.test(code)) return new HubError('tls', message, null, code);
  return new HubError('network', message, null, code);
}

interface RawResponse {
  status: number;
  date: string | undefined;
  body: Buffer;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Hub bilan imzolangan HTTPS. TLS tekshiruvi hech qachon o'chirilmaydi: `ca` berilsa faqat unga ishoniladi,
// aks holda tizim root'lariga; hostname har doim tekshiriladi.
export class HubClient {
  readonly origin: string;
  readonly agent: Agent;
  readonly #url: URL;
  readonly #signer: RequestSigner | null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(opts: { origin: string; ca: string | null; signer: RequestSigner | null }) {
    this.#url = parseOrigin(opts.origin);
    this.origin = opts.origin;
    this.#signer = opts.signer;
    this.agent = new Agent({ keepAlive: true, ...(opts.ca ? { ca: opts.ca } : {}) });
  }

  json<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
    opts: JsonOptions = {},
  ): Promise<T> {
    const run = () => this.#exchange(method, path, body, schema, opts);
    if (opts.lane === 'poll') return run();
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.agent.destroy();
  }

  async #exchange<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
    opts: JsonOptions,
  ): Promise<T> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let res = await this.#once(method, path, payload, opts);
    // 401: soat noto'g'ri bo'lishi yoki imzolar tartibi buzilishi mumkin — soatni hub vaqtiga moslab bir marta qayta imzolanadi.
    if (res.status === 401 && this.#signer) {
      const hubTime = res.date ? Date.parse(res.date) : Number.NaN;
      if (Number.isFinite(hubTime)) this.#signer.syncClock(hubTime);
      await sleep(RETRY_DELAY_MS);
      res = await this.#once(method, path, payload, opts);
    }
    return this.#finish(res, schema);
  }

  #finish<T>(res: RawResponse, schema: z.ZodType<T> | null): T {
    if (res.status < 200 || res.status >= 300) {
      let code: string | null = null;
      let message = `hub answered ${res.status}`;
      try {
        const envelope = JSON.parse(res.body.toString('utf8')) as { error?: { code?: unknown; message?: unknown } };
        if (typeof envelope.error?.code === 'string') code = envelope.error.code;
        if (typeof envelope.error?.message === 'string') message = envelope.error.message;
      } catch {
        // JSON bo'lmagan javob: status yetarli
      }
      throw new HubError('http', message, res.status, code);
    }
    if (schema === null) return undefined as T;
    try {
      const parsed = schema.safeParse(JSON.parse(res.body.toString('utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // quyida bir xil xato
    }
    throw new HubError('http', 'hub answered with an unexpected body', res.status, 'invalid_response');
  }

  #once(method: string, path: string, payload: Buffer | null, opts: JsonOptions): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const headers: Record<string, string | number> = { accept: 'application/json' };
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = payload.length;
      }
      if (this.#signer) Object.assign(headers, this.#signer.sign(method, path, payload ?? Buffer.alloc(0)));
      const options: RequestOptions = {
        agent: this.agent,
        hostname: this.#url.hostname.replace(/^\[|\]$/g, ''),
        port: this.#url.port || 443,
        method,
        path,
        headers,
      };
      const abort = opts.signal;
      let onAbort: (() => void) | null = null;
      const done = () => {
        if (abort && onAbort) abort.removeEventListener('abort', onAbort);
      };
      const req = request(options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new HubError('network', 'hub response too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          done();
          resolve({ status: res.statusCode ?? 0, date: res.headers.date, body: Buffer.concat(chunks) });
        });
        res.on('error', (err) => {
          done();
          reject(toHubError(err));
        });
      });
      req.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, () =>
        req.destroy(new HubError('timeout', 'hub request timed out')),
      );
      req.on('error', (err) => {
        done();
        reject(toHubError(err));
      });
      if (abort) {
        onAbort = () => req.destroy(new HubError('network', 'request aborted', null, 'aborted'));
        if (abort.aborted) onAbort();
        else abort.addEventListener('abort', onAbort, { once: true });
      }
      req.end(payload ?? undefined);
    });
  }
}
