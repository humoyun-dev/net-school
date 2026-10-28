import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const VALID = /^[A-Za-z0-9-]{8,64}$/;
const ids = new WeakMap<Request, string>();

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-correlation-id'];
  const id = typeof incoming === 'string' && VALID.test(incoming) ? incoming : randomUUID();
  ids.set(req, id);
  res.setHeader('x-correlation-id', id);
  next();
}

export function correlationIdOf(req: Request): string {
  return ids.get(req) ?? '';
}
