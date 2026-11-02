import { describe, expect, test } from 'vitest';
import { pickLocale, strings } from '../src/core/i18n.ts';

describe('i18n', () => {
  test('every locale has every key', () => {
    const keys = Object.keys(strings.uz).sort();
    expect(keys.length).toBeGreaterThan(15);
    for (const locale of ['ru', 'en'] as const) {
      expect(Object.keys(strings[locale]).sort(), locale).toEqual(keys);
    }
    for (const locale of ['uz', 'ru', 'en'] as const) {
      for (const [key, value] of Object.entries(strings[locale])) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('');
        expect(value, `${locale}.${key}`).not.toMatch(/[<>]/); // matn hech qachon HTML emas
      }
    }
  });

  test('ru-RU picks ru and unknown locales fall back to uz', () => {
    expect(pickLocale('ru-RU')).toBe('ru');
    expect(pickLocale('ru')).toBe('ru');
    expect(pickLocale('en-US')).toBe('en');
    expect(pickLocale('en')).toBe('en');
    expect(pickLocale('uz-UZ')).toBe('uz');
    for (const other of ['de-DE', '', 'zz', 'fr']) expect(pickLocale(other), other).toBe('uz');
  });
});
