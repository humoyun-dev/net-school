import { type CapabilityReport, type HelperStatus, helperStatusSchema, MAX_CAPABILITIES } from '@netschool/contracts';

// Helper hisoboti shu muddatdan eski bo'lsa, unga tayanilmaydi (helper har 5 s so'raydi, holatni o'zgarganda yoki
// davriy yuboradi).
export const HELPER_STATUS_FRESH_MS = 90_000;

type Capability = CapabilityReport['capabilities'][string];

const COMPONENTS = [
  ['hook', 'hook_failed'],
  ['policy', 'policy_failed'],
  ['processGuard', 'process_guard_failed'],
] as const;

// Overlay darajasi (P2d1, ADR 0014). `locked` — hub'ning o'z faol bloklash holati (faol dars overlay'i), komponent
// holatlaridan taxmin qilinmaydi. Yangi helper hisoboti bilan:
//   - bloklash yo'q: hech bir komponent `failed` bo'lmasa `hard` (bloklashda komponentlar `off` dan `active`ga o'tadi);
//     biri `failed` bo'lsa `soft` + o'sha komponentning `*_failed` sababi;
//   - bloklangan: hook, siyosat va process guard uchalasi `active` va Companion `running` bo'lsa `hard`; aks holda
//     `soft` + `active` bo'lmagan birinchi komponentning (hook → policy → processGuard) `*_failed` sababi, ular
//     hammasi `active` bo'lsa `companion_down` (ekranni overlay yopadi, uni Companion ko'rsatadi: o'quvchi uni
//     o'ldirib tursa yoki sessiyada yo'q bo'lsa daraja kuchli emas).
// Helper hisoboti yo'q, eski yoki yaroqsiz: Companion hisoboti, lekin hech qachon `hard` emas (`helper_missing`).
function overlay(entry: Capability, helper: HelperStatus | null, locked: boolean): Capability {
  if (entry.state !== 'available') return entry;
  const { reason: _reason, ...rest } = entry;
  if (helper) {
    const weak = locked
      ? COMPONENTS.find(([key]) => helper[key] !== 'active')
      : COMPONENTS.find(([key]) => helper[key] === 'failed');
    if (weak) return { ...rest, enforcement: 'soft', reason: weak[1] };
    if (locked && helper.companion !== 'running') return { ...rest, enforcement: 'soft', reason: 'companion_down' };
    return { ...rest, enforcement: 'hard' };
  }
  if (entry.enforcement === 'hard') return { ...rest, enforcement: 'soft', reason: 'helper_missing' };
  return entry;
}

// Ctrl+Alt+Del ekranini to'sish (Keyboard Filter, faqat Education/Enterprise/IoT): `off` — tayyor, faqat bloklash yo'q.
function sasBlock(helper: HelperStatus | null): Capability {
  if (!helper) return { state: 'unsupported', reason: 'helper_missing' };
  switch (helper.cad) {
    case 'blocked':
    case 'off':
      return { state: 'available' };
    case 'unavailable':
      return { state: 'unsupported', reason: 'edition' };
    case 'failed':
      return { state: 'unsupported', reason: 'failed' };
  }
}

// Hub qo'shadigan kalitlar uchun joy: Companion'ning `classroom.*` bo'lmagan kalitlari tartiblangan ro'yxat oxiridan
// tashlanadi, natija MAX_CAPABILITIES dan oshmaydi (aks holda panelning deviceSchema'si butun xona ro'yxatini rad etadi).
function makeRoom(capabilities: CapabilityReport['capabilities'], needed: number): boolean {
  const droppable = Object.keys(capabilities)
    .filter((name) => !name.startsWith('classroom.'))
    .sort();
  while (Object.keys(capabilities).length + needed > MAX_CAPABILITIES) {
    const name = droppable.pop();
    if (name === undefined) return false;
    delete capabilities[name];
  }
  return true;
}

// Panelga ko'rsatiladigan capability'lar: Companion hisoboti + helper holati va hub bloklash holatidan hisoblangan
// daraja. Saqlangan hisobot o'zgarmaydi; hisob har o'qishda joriy vaqt bilan qilinadi.
export function effectiveCapabilities(
  report: CapabilityReport | null,
  helperStatus: unknown,
  helperStatusAt: Date | null,
  locked: boolean,
  now: number,
): CapabilityReport | null {
  if (!report) return null;
  const fresh = helperStatusAt !== null && now - helperStatusAt.getTime() <= HELPER_STATUS_FRESH_MS;
  // Saqlangan holat qayta tekshiriladi: yaroqsiz bo'lsa (masalan, eski shakl) helper hisoboti yo'q deb hisoblanadi.
  const parsed = fresh ? helperStatusSchema.safeParse(helperStatus) : null;
  const helper = parsed?.success ? parsed.data : null;
  const capabilities = { ...report.capabilities };
  const current = capabilities['classroom.overlay'];
  if (current) capabilities['classroom.overlay'] = overlay(current, helper, locked);
  // Bu kalit faqat hub'niki (Companion yuborgani hisobga olinmaydi). Helper faqat Windows'da; boshqa OS'larda yo'q.
  delete capabilities['classroom.sas_block'];
  if ((report.os === 'windows' || helper) && makeRoom(capabilities, 1)) {
    capabilities['classroom.sas_block'] = sasBlock(helper);
  }
  return { ...report, capabilities };
}
