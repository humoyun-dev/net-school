import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { type PersistedOverlay, StateCache } from '../src/core/cache.ts';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'ns-cache-')), 'state.sqlite');
const HOUR = 3_600_000;

const overlay: PersistedOverlay = {
  lessonId: '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a',
  locked: true,
  sequence: '42',
  message: 'Diqqat',
  bootTimeMs: 1_800_000_000_000,
  deadlineUptimeMs: 5_000_000,
};

describe('state cache', () => {
  test('outcomes survive reopen', () => {
    const file = tempFile();
    const first = StateCache.open(file);
    first.recordOutcome('c-ok', { status: 'succeeded' }, 1_000);
    first.recordOutcome('c-bad', { status: 'failed', reason: 'unsupported' }, 1_001);
    first.close();

    const second = StateCache.open(file);
    expect(second.outcomeOf('c-ok')).toEqual({ status: 'succeeded' });
    expect(second.outcomeOf('c-bad')).toEqual({ status: 'failed', reason: 'unsupported' });
    expect(second.outcomeOf('unknown')).toBeNull();
    second.close();
  });

  test('old outcomes are pruned', () => {
    const cache = StateCache.open(':memory:');
    cache.recordOutcome('old', { status: 'succeeded' }, 1_000);
    cache.recordOutcome('fresh', { status: 'succeeded' }, 1_000 + 24 * HOUR - 1);
    // 24 soatdan eski yozuv keyingi yozishda o'chadi, undan yangisi qoladi.
    expect(cache.outcomeOf('old')).toEqual({ status: 'succeeded' });
    cache.recordOutcome('newest', { status: 'succeeded' }, 1_000 + 24 * HOUR + 1);
    expect(cache.outcomeOf('old')).toBeNull();
    expect(cache.outcomeOf('fresh')).toEqual({ status: 'succeeded' });
    cache.close();
  });

  test('only the newest thousand outcomes are kept', () => {
    const cache = StateCache.open(':memory:');
    for (let i = 0; i < 1_005; i++) cache.recordOutcome(`c-${i}`, { status: 'succeeded' }, 10_000 + i);
    expect(cache.outcomeOf('c-0')).toBeNull();
    expect(cache.outcomeOf('c-4')).toBeNull();
    expect(cache.outcomeOf('c-5')).toEqual({ status: 'succeeded' });
    expect(cache.outcomeOf('c-1004')).toEqual({ status: 'succeeded' });
    cache.close();
  });

  test('re-recording a command replaces its outcome', () => {
    const cache = StateCache.open(':memory:');
    cache.recordOutcome('c', { status: 'failed', reason: 'error' }, 1);
    cache.recordOutcome('c', { status: 'succeeded' }, 2);
    expect(cache.outcomeOf('c')).toEqual({ status: 'succeeded' });
    cache.close();
  });

  test('the overlay round-trips, clears and survives reopen', () => {
    const file = tempFile();
    const cache = StateCache.open(file);
    expect(cache.loadOverlay()).toBeNull();
    cache.saveOverlay(overlay);
    expect(cache.loadOverlay()).toEqual(overlay);
    cache.close();

    const reopened = StateCache.open(file);
    expect(reopened.loadOverlay()).toEqual(overlay);
    reopened.saveOverlay({ ...overlay, sequence: null, message: null });
    expect(reopened.loadOverlay()).toMatchObject({ sequence: null, message: null });
    reopened.saveOverlay(null);
    expect(reopened.loadOverlay()).toBeNull();
    reopened.close();
  });

  test('a corrupt overlay row loads as no overlay', () => {
    const file = tempFile();
    const cache = StateCache.open(file);
    cache.saveOverlay(overlay);
    const raw = new DatabaseSync(file);
    raw.exec('UPDATE overlay SET json = \'{"locked":"yes"}\'');
    raw.close();
    expect(cache.loadOverlay()).toBeNull();
    cache.close();
  });

  test('policy baseline round-trips and a corrupt row reads as null', () => {
    const cache = StateCache.open(':memory:');
    expect(cache.loadBaseline()).toBeNull();
    const baseline = {
      revision: { org: 2, site: 1 },
      hash: 'f'.repeat(64),
      document: {
        web: { blocked: ['bad.com'] },
        browser: { managed: true, incognito: 'disabled' as const, devTools: 'allowed' as const },
        os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
      },
    };
    cache.saveBaseline(baseline);
    expect(cache.loadBaseline()).toEqual(baseline);
    cache.saveBaseline({ ...baseline, hash: 'not-a-hash' });
    expect(cache.loadBaseline()).toBeNull();
    cache.close();
  });
});
