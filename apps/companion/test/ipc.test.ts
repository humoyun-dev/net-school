import { describe, expect, test } from 'vitest';
import { dismissArgSchema, isTrustedSender } from '../src/main/ipc.ts';

const ROOT = '/app/dist/renderer';

describe('ipc sender check', () => {
  test('ipc rejects calls from frames outside the app', () => {
    expect(isTrustedSender('file:///app/dist/renderer/status.html', ROOT)).toBe(true);
    expect(isTrustedSender('file:///app/dist/renderer/overlay.html?x=1#y', ROOT)).toBe(true);
    for (const url of [
      'https://evil.example/status.html',
      'http://localhost/app/dist/renderer/status.html',
      'file:///app/dist/renderer-evil/status.html', // prefiks hiylasi
      'file:///app/dist/renderer/../secret.html',
      'file:///etc/passwd',
      'about:blank',
      'data:text/html,<script>1</script>',
      '',
      'not a url',
    ]) {
      expect(isTrustedSender(url, ROOT), url).toBe(false);
    }
    expect(isTrustedSender(undefined, ROOT)).toBe(false);
  });

  test('the dismiss argument must be a uuid', () => {
    expect(dismissArgSchema.safeParse('7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a').success).toBe(true);
    for (const bad of ['', 'x', 42, null, undefined, { id: 1 }, '../../etc']) {
      expect(dismissArgSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});
