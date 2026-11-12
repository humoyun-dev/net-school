import { describe, expect, test } from 'vitest';
import {
  activeRules,
  type BaselineDocument,
  type EffectiveBaseline,
  effectiveWeb,
  type LessonDocument,
  matchesUrl,
  mergeBaseline,
  normalizePattern,
  receiptStatus,
} from '../src/index.ts';

const base = (over: Partial<EffectiveBaseline> = {}): EffectiveBaseline => ({
  web: { blocked: [] },
  browser: { managed: false, incognito: 'allowed', devTools: 'allowed' },
  os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
  ...over,
});
const lesson = (mode: LessonDocument['web']['mode'], patterns: string[]): LessonDocument => ({
  schemaVersion: 1,
  web: { mode, patterns },
});

describe('url patterns', () => {
  test('normalizes and rejects url patterns', () => {
    expect(normalizePattern('HTTPS://Example.COM./Docs')).toBe('example.com/docs');
    expect(normalizePattern('*.Пример.рф')).toBe('*.xn--e1afmkfd.xn--p1ai');
    expect(normalizePattern('example.com:8080')).toBe('example.com');
    expect(normalizePattern('http://example.com/')).toBe('example.com');
    expect(normalizePattern('  example.com  ')).toBe('example.com');
    for (const bad of [
      'a b.com',
      'exa(mple).com',
      'javascript:alert(1)',
      'ftp://example.com',
      '*example.com',
      'ex.*.com',
      '*.',
      '',
      `${'a'.repeat(301)}.com`,
      'example.com/a b',
      'user@example.com',
      'example.com?q=1',
    ]) {
      expect(normalizePattern(bad), bad).toBeNull();
    }
  });

  test('wildcard matches the domain and its subdomains only', () => {
    expect(matchesUrl('*.example.com', new URL('https://a.example.com/x'))).toBe(true);
    expect(matchesUrl('*.example.com', new URL('https://example.com/'))).toBe(true);
    expect(matchesUrl('*.example.com', new URL('https://badexample.com/'))).toBe(false);
    expect(matchesUrl('example.com', new URL('https://a.example.com/'))).toBe(false);
  });

  test('path matching resists case, encoding and slash tricks', () => {
    expect(normalizePattern('example.com/a%20b')).toBeNull();
    expect(normalizePattern('Example.com/Docs')).toBe('example.com/docs');
    for (const url of [
      'https://example.com/DOCS/a',
      'https://example.com/%64ocs/a',
      'https://example.com//docs/a',
      'https://example.com/./docs/a',
      'https://example.com/x/../docs',
      'https://example.com/docs;x=1/a',
    ]) {
      expect(matchesUrl('example.com/docs', new URL(url)), url).toBe(true);
    }
  });

  test('path prefix matches by segment prefix', () => {
    expect(matchesUrl('example.com/docs', new URL('https://example.com/docs/a'))).toBe(true);
    expect(matchesUrl('example.com/docs', new URL('https://example.com/doc'))).toBe(false);
    expect(matchesUrl('example.com', new URL('http://EXAMPLE.com./any'))).toBe(true);
  });
});

describe('layer merge', () => {
  test('stricter value wins across org and site', () => {
    const org: BaselineDocument = { schemaVersion: 1, browser: { managed: true, incognito: 'allowed' } };
    const site: BaselineDocument = { schemaVersion: 1, browser: { managed: false, incognito: 'disabled' } };
    const merged = mergeBaseline(org, site);
    expect(merged.browser).toEqual({ managed: true, incognito: 'disabled', devTools: 'allowed' });
  });

  test('blocked lists are unioned without duplicates', () => {
    const org: BaselineDocument = { schemaVersion: 1, web: { blocked: ['b.com', 'a.com'] } };
    const site: BaselineDocument = {
      schemaVersion: 1,
      web: { blocked: ['a.com', 'c.com'] },
      os: { lockWallpaper: true },
    };
    const merged = mergeBaseline(org, site);
    expect(merged.web.blocked).toEqual(['a.com', 'b.com', 'c.com']);
    expect(merged.os).toEqual({ standardUser: false, blockAppInstall: false, lockWallpaper: true });
  });

  test('no documents give defaults', () => {
    expect(mergeBaseline(null, null)).toEqual(base());
  });

  test('effectiveWeb keeps baseline blocks inside a lesson allowlist', () => {
    const b = base({ web: { blocked: ['bad.com'] } });
    expect(effectiveWeb(b, lesson('allowlist', ['bad.com', 'good.com']))).toEqual({
      block: ['bad.com'],
      allowOnly: ['bad.com', 'good.com'],
    });
  });

  test('lesson blocklist adds to baseline blocks', () => {
    const b = base({ web: { blocked: ['bad.com'] } });
    expect(effectiveWeb(b, lesson('blocklist', ['game.com', 'bad.com']))).toEqual({
      block: ['bad.com', 'game.com'],
      allowOnly: null,
    });
  });

  test('lesson off or absent leaves only the baseline', () => {
    const b = base({ web: { blocked: ['bad.com'] } });
    const only = { block: ['bad.com'], allowOnly: null };
    expect(effectiveWeb(b, lesson('off', ['x.com']))).toEqual(only);
    expect(effectiveWeb(b, null)).toEqual(only);
  });
});

describe('rules and receipt status', () => {
  test('companion answers for web rules', () => {
    expect(activeRules('baseline', base(), 'companion')).toEqual([]);
    expect(activeRules('baseline', base({ web: { blocked: ['a.com'] } }), 'companion')).toEqual(['web.blocked']);
    expect(activeRules('lesson', lesson('allowlist', []), 'companion')).toEqual(['web.lesson']);
    expect(activeRules('lesson', lesson('off', []), 'companion')).toEqual([]);
  });

  test('helper answers for browser and os rules', () => {
    expect(activeRules('baseline', base(), 'helper')).toEqual([]);
    const managed = base({ browser: { managed: true, incognito: 'disabled', devTools: 'allowed' } });
    expect(activeRules('baseline', managed, 'helper')).toEqual([
      'browser.managed',
      'browser.onlyManaged',
      'browser.incognito',
    ]);
    const os = base({ os: { standardUser: true, blockAppInstall: false, lockWallpaper: true } });
    expect(activeRules('baseline', os, 'helper')).toEqual(['os.standardUser', 'os.lockWallpaper']);
    expect(activeRules('baseline', managed, 'companion')).toEqual([]);
  });

  test('receipt status is applied, partial or failed', () => {
    expect(receiptStatus([], {})).toBe('applied');
    expect(receiptStatus(['web.blocked'], { 'web.blocked': { state: 'applied' } })).toBe('applied');
    expect(receiptStatus(['web.blocked'], { 'web.blocked': { state: 'failed' } })).toBe('failed');
    expect(receiptStatus(['web.blocked'], {})).toBe('failed');
    expect(
      receiptStatus(['browser.managed', 'os.standardUser'], {
        'browser.managed': { state: 'applied' },
        'os.standardUser': { state: 'unsupported' },
      }),
    ).toBe('partial');
  });
});
