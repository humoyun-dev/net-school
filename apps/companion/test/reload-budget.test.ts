import { describe, expect, test } from 'vitest';
import { onOverlayGone, ReloadBudget } from '../src/core/reload-budget.ts';

function budget() {
  let now = 0;
  const b = new ReloadBudget({ max: 3, windowMs: 60_000, nowMs: () => now });
  return { b, advance: (ms: number) => (now += ms) };
}

describe('ReloadBudget', () => {
  test('60 s ichida 3 ta qayta yuklash darhol, keyingisi eng eski slot bo‘shaguncha kutadi', () => {
    const { b, advance } = budget();
    expect(b.reserve()).toBe(0);
    advance(1_000);
    expect(b.reserve()).toBe(0);
    advance(1_000);
    expect(b.reserve()).toBe(0);
    advance(1_000);
    // 3 s da: birinchisi 0 s da edi, slot 60 s da bo'shaydi.
    expect(b.reserve()).toBe(57_000);
    // Keyingisi ikkinchi (1 s) slotdan keyin: 61 s.
    expect(b.reserve()).toBe(58_000);
  });

  test('oyna o‘tgach yana darhol', () => {
    const { b, advance } = budget();
    b.reserve();
    b.reserve();
    b.reserve();
    advance(60_000);
    expect(b.reserve()).toBe(0);
  });

  test('har qanday 60 s oynada 3 tadan ko‘p emas', () => {
    const { b, advance } = budget();
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const wait = b.reserve();
      times.push(t + wait);
      advance(500);
      t += 500;
    }
    for (const start of times) {
      expect(times.filter((x) => x >= start && x < start + 60_000).length).toBeLessThanOrEqual(3);
    }
  });
});

describe('onOverlayGone', () => {
  test('4-o‘ldirish: oyna darhol ko‘rsatiladi, reload ~57 s kechiktiriladi', () => {
    const { b, advance } = budget();
    for (let i = 0; i < 3; i++) {
      expect(onOverlayGone(b, false)).toEqual({ reveal: true, reloadIn: 0 });
      advance(1_000);
    }
    expect(onOverlayGone(b, false)).toEqual({ reveal: true, reloadIn: 57_000 });
  });

  test('clean-exit (TerminateProcess(h, 0)) ham boshqa sabablardek: ko‘rsatiladi va qayta yuklanadi', () => {
    // Sabab qarorga ta'sir qilmaydi: onOverlayGone uni umuman olmaydi.
    const { b } = budget();
    expect(onOverlayGone(b, false)).toEqual({ reveal: true, reloadIn: 0 });
  });

  test('reload allaqachon kutilayotgan bo‘lsa: faqat ko‘rsatiladi, yangi slot band qilinmaydi', () => {
    const { b } = budget();
    expect(onOverlayGone(b, true)).toEqual({ reveal: true, reloadIn: null });
    expect(b.reserve()).toBe(0);
    expect(b.reserve()).toBe(0);
    expect(b.reserve()).toBe(0);
  });
});
