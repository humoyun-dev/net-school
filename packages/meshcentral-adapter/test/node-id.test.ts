import { describe, expect, test } from 'vitest';
import { AdapterError } from '../src/errors.ts';
import { formatNodeId, parseNodeId } from '../src/node-id.ts';
import { scope } from './scope.ts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AdapterError ? err.code : 'not-adapter-error';
  }
  return undefined;
}

describe('parseNodeId', () => {
  test('parses a default-domain node id into an upstream ref', () => {
    expect(parseNodeId('node//abc', scope)).toEqual({ meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: 'abc' });
  });

  test('round-trips through formatNodeId', () => {
    expect(formatNodeId(parseNodeId('node//a$b@c', scope))).toBe('node//a$b@c');
  });

  test('parseNodeId rejects foreign domain', () => {
    expect(codeOf(() => parseNodeId('node/other/abc', scope))).toBe('scope_denied');
  });

  test('rejects malformed ids', () => {
    expect(codeOf(() => parseNodeId('user//abc', scope))).toBe('invalid_upstream_message');
    expect(codeOf(() => parseNodeId('node/x', scope))).toBe('invalid_upstream_message');
    expect(codeOf(() => parseNodeId('node//', scope))).toBe('invalid_upstream_message');
  });
});
