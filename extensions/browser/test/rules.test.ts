import { describe, expect, test } from 'vitest';
import { type DnrRule, isBlocked, MAX_PATTERNS_PER_REGEX, toDnrRules } from '../src/rules.ts';

// DNR mosligini soddalashtirib simulyatsiya qiladi: eng yuqori ustuvorlikdagi mos qoida g'olib (Chrome xulqi).
function decide(rules: DnrRule[], url: string, type: 'main_frame' | 'sub_frame' | 'image' = 'main_frame') {
  const u = new URL(url);
  const matching = rules.filter((r) => {
    const c = r.condition;
    if (c.resourceTypes && !c.resourceTypes.includes(type)) return false;
    if (c.requestDomains && !c.requestDomains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`)))
      return false;
    if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url))
      return false;
    if (c.urlFilter === '|http' && !url.startsWith('http')) return false;
    return true;
  });
  matching.sort((a, b) => b.priority - a.priority);
  return matching[0]?.action.type ?? 'none';
}
const blocked = (rules: DnrRule[], url: string) => ['block', 'redirect'].includes(decide(rules, url));

describe('dnr rules', () => {
  test('allowlist never unblocks a baseline block', () => {
    const rules = toDnrRules({ block: ['bad.com'], allowOnly: ['bad.com', 'good.com'] });
    expect(blocked(rules, 'https://bad.com/')).toBe(true);
    expect(blocked(rules, 'https://good.com/x')).toBe(false);
    expect(blocked(rules, 'https://other.com/')).toBe(true);
    expect(decide(rules, 'https://bad.com/')).toBe('redirect');
    expect(decide(rules, 'https://bad.com/', 'sub_frame')).toBe('block');
  });

  test('blocklist only blocks listed hosts', () => {
    const rules = toDnrRules({ block: ['*.game.com', 'chat.example.com'], allowOnly: null });
    expect(blocked(rules, 'https://game.com/')).toBe(true);
    expect(blocked(rules, 'https://www.game.com/')).toBe(true);
    expect(blocked(rules, 'https://chat.example.com/')).toBe(true);
    expect(blocked(rules, 'https://example.com/')).toBe(false);
    expect(blocked(rules, 'https://a.chat.example.com/')).toBe(false);
    expect(blocked(rules, 'https://notgame.com/')).toBe(false);
  });

  test('path patterns resist case and repeated slashes', () => {
    const rules = toDnrRules({ block: ['example.com/docs'], allowOnly: null });
    for (const url of ['https://example.com/docs', 'https://example.com/DOCS/a', 'https://example.com//docs?x=1']) {
      expect(blocked(rules, url), url).toBe(true);
    }
    expect(blocked(rules, 'https://example.com/docsx')).toBe(false);
    expect(blocked(rules, 'https://example.com/')).toBe(false);
  });

  test('userinfo and ;params do not slip past a block', () => {
    const rules = toDnrRules({ block: ['bad.com', 'example.com/docs'], allowOnly: null });
    expect(blocked(rules, 'https://user:pw@bad.com/')).toBe(true);
    expect(blocked(rules, 'https://example.com/docs;jsessionid=1')).toBe(true);
    const allow = toDnrRules({ block: [], allowOnly: ['good.com'] });
    expect(blocked(allow, 'https://good.com@bad.com/')).toBe(true);
    // `;` faqat yo'l segmentidan keyin chegara: host'dan keyin emas.
    expect(blocked(allow, 'https://good.com;.bad.com/')).toBe(true);
  });

  test('group size can be reduced for unsupported regexes', () => {
    const block = Array.from({ length: 5 }, (_, i) => `s${i}.com`);
    expect(toDnrRules({ block, allowOnly: null }, 1).length).toBe(10);
  });

  test('allowOnly empty blocks all http(s) navigation but not subresources', () => {
    const rules = toDnrRules({ block: [], allowOnly: [] });
    expect(blocked(rules, 'https://any.com/')).toBe(true);
    expect(blocked(rules, 'http://any.com/')).toBe(true);
    expect(decide(rules, 'https://cdn.com/a.png', 'image')).toBe('none');
  });

  test('no policy gives no rules', () => {
    expect(toDnrRules({ block: [], allowOnly: null })).toEqual([]);
  });

  test('many patterns are grouped and rule ids are unique', () => {
    const block = Array.from({ length: 1000 }, (_, i) => `s${i}.com/p`);
    const rules = toDnrRules({ block, allowOnly: null });
    expect(rules.length).toBeLessThanOrEqual(2 * Math.ceil(1000 / MAX_PATTERNS_PER_REGEX));
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    expect(blocked(rules, 'https://s999.com/p/x')).toBe(true);
  });
});

describe('navigation backstop', () => {
  test('canonical check catches encoded paths DNR may miss', () => {
    const web = { block: ['example.com/docs'], allowOnly: null };
    expect(isBlocked(web, 'https://example.com/%64ocs/a')).toBe(true);
    expect(isBlocked(web, 'https://example.com/other')).toBe(false);
  });

  test('encoded separators cannot widen a lesson allowlist', () => {
    const web = { block: [], allowOnly: ['example.com/docs'] };
    expect(isBlocked(web, 'https://example.com/secret%2f..%2fdocs')).toBe(true);
    expect(isBlocked(web, 'https://example.com/docs/a')).toBe(false);
  });

  test('allowOnly blocks other http(s) pages and ignores browser pages', () => {
    const web = { block: ['bad.com'], allowOnly: ['bad.com', 'docs.com'] };
    expect(isBlocked(web, 'https://docs.com/a')).toBe(false);
    expect(isBlocked(web, 'https://bad.com/')).toBe(true);
    expect(isBlocked(web, 'https://x.com/')).toBe(true);
    expect(isBlocked(web, 'chrome://newtab/')).toBe(false);
    expect(isBlocked(web, 'not a url')).toBe(false);
  });
});
