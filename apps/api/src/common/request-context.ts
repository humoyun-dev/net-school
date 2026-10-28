import type { Actor } from '@netschool/domain';
import type { Request } from 'express';
import { correlationIdOf } from './correlation.ts';

export interface RequestContext {
  correlationId: string;
  clientIp: string;
  actor: Actor | null;
  sessionId: string | null;
}

const auth = new WeakMap<Request, { actor: Actor; sessionId: string }>();

// Auth guard sessiyani tekshirgach shu yerga yozadi.
export function setAuthenticated(req: Request, actor: Actor, sessionId: string): void {
  auth.set(req, { actor, sessionId });
}

export function requestContext(req: Request): RequestContext {
  const found = auth.get(req);
  return {
    correlationId: correlationIdOf(req),
    clientIp: req.socket.remoteAddress ?? '',
    actor: found?.actor ?? null,
    sessionId: found?.sessionId ?? null,
  };
}
