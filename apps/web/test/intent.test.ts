import { describe, expect, test } from 'vitest';
import { ApiFailure } from '../src/api/client.ts';
import { createIntent } from '../src/api/intent.ts';

describe('intent idempotency keys', () => {
  test('a retried intent reuses its idempotency key', async () => {
    const keys: string[] = [];
    let fail = true;
    const intent = createIntent(async (key) => {
      keys.push(key);
      if (fail) throw new TypeError('Failed to fetch');
      return 'ok';
    });
    await expect(intent.run()).rejects.toThrow('Failed to fetch');
    fail = false;
    expect(await intent.run()).toBe('ok');
    expect(keys[0]).toBe(keys[1]);
    await intent.run();
    expect(keys[2]).not.toBe(keys[1]);
  });

  test('a server 5xx keeps the key; a definite 4xx answer rotates it', async () => {
    const keys: string[] = [];
    let error: unknown = new ApiFailure(503, 'upstream_unavailable', 'down', null);
    const intent = createIntent(async (key) => {
      keys.push(key);
      throw error;
    });
    await intent.run().catch(() => {});
    error = new ApiFailure(409, 'conflict', 'no', null);
    await intent.run().catch(() => {});
    await intent.run().catch(() => {});
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test('keys match the API format', async () => {
    const intent = createIntent(async (key) => key);
    expect(await intent.run()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});
