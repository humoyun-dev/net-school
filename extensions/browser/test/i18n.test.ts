import { expect, test } from 'vitest';
import { blockedText } from '../src/i18n.ts';

test('blocked page text follows the browser language', () => {
  expect(blockedText('ru-RU').title).toBe('Сайт ограничен');
  expect(blockedText('en-US').title).toBe('Site restricted');
  expect(blockedText('uz').title).toBe('Sayt cheklangan');
  expect(blockedText('de').title).toBe('Sayt cheklangan');
});
