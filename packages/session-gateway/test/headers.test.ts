import { describe, expect, test } from 'vitest';
import { sanitizeResponseHeaders } from '../src/headers.ts';

const PANEL = 'https://hub.school.lan';

describe('gateway response headers for the embedded viewer', () => {
  test('x-frame-options is removed and frame-ancestors names the panel origin', () => {
    const out = sanitizeResponseHeaders(
      { 'x-frame-options': 'SAMEORIGIN', 'content-type': 'text/html' },
      { frameAncestor: PANEL },
    );
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBe(`frame-ancestors ${PANEL}`);
    expect(out['content-type']).toBe('text/html');
  });

  test('an upstream CSP keeps its directives but frame-ancestors is replaced', () => {
    const out = sanitizeResponseHeaders(
      { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src 'self' data:" },
      { frameAncestor: PANEL },
    );
    expect(out['content-security-policy']).toBe(
      `default-src 'self'; img-src 'self' data:; frame-ancestors ${PANEL}`,
    );
  });

  test('without a frame ancestor the headers pass through unchanged', () => {
    const out = sanitizeResponseHeaders({ 'x-frame-options': 'SAMEORIGIN' });
    expect(out['x-frame-options']).toBe('SAMEORIGIN');
    expect(out['content-security-policy']).toBeUndefined();
  });
});
