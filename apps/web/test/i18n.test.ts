import { API_ERROR_CODES } from '@netschool/contracts';
import { describe, expect, test } from 'vitest';
import { format, LOCALES, pickLocale, strings } from '../src/i18n/strings.ts';

describe('i18n', () => {
  test('every locale has every key and every API error code', () => {
    const keys = Object.keys(strings.uz).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(strings[locale]).sort(), locale).toEqual(keys);
      for (const value of Object.values(strings[locale])) expect(value.trim(), locale).not.toBe('');
    }
    for (const code of API_ERROR_CODES) expect(keys, code).toContain(`error.${code}`);
  });

  test('placeholders are filled and locales are picked from the browser', () => {
    expect(format('{n} ta qurilma', { n: 3 })).toBe('3 ta qurilma');
    expect(pickLocale('ru-RU')).toBe('ru');
    expect(pickLocale('en-GB')).toBe('en');
    expect(pickLocale('de')).toBe('uz');
  });
});
