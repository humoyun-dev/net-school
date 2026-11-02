import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';

// API'ga tegishli yo'llar: SPA ularni hech qachon yutmaydi (JSON 404 qoladi).
const API_PREFIX = /^\/api(\/|$)/;

export function webCsp(gatewayOrigin: string | null): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    // 'self' same-origin wss:// ni ham qamraydi (miniatura oqimi).
    "connect-src 'self'",
    `frame-src ${gatewayOrigin ?? "'none'"}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

// Veb-panel API o'z origin'idan beriladi: sessiya cookie'si __Host- va SameSite=Strict, Origin tekshiruvi
// PUBLIC_ORIGIN'ga aynan teng, CORS yo'q. Faqat GET/HEAD; fayl topilmasa index.html (client-side routing).
export function mountStaticWeb(app: NestExpressApplication, opts: { dir: string; gatewayOrigin: string | null }): void {
  const root = resolve(opts.dir);
  const index = readFileSync(join(root, 'index.html'));
  const csp = webCsp(opts.gatewayOrigin);
  const security = (res: Response) => {
    res.setHeader('content-security-policy', csp);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
  };
  const assets = express.static(join(root, 'assets'), {
    index: false,
    fallthrough: false,
    immutable: true,
    maxAge: '365d',
    dotfiles: 'deny',
    setHeaders: (res) => {
      security(res);
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API_PREFIX.test(req.path)) return next();
    if (req.path.startsWith('/assets/')) {
      // express.static (send) yo'lni root ichida ushlaydi; '..' bilan chiqish 403/404.
      req.url = req.url.slice('/assets'.length);
      return assets(req, res, (err?: unknown) => {
        const status = (err as { status?: number } | undefined)?.status ?? 404;
        security(res);
        res
          .status(status === 403 ? 404 : status)
          .type('text/plain')
          .send('Not found');
      });
    }
    // Boshqa har yo'l — SPA. Fayl tizimiga murojaat yo'q, shuning uchun traversal mumkin emas.
    security(res);
    res.setHeader('cache-control', 'no-store');
    res.type('html').send(index);
  });
}
