import type { CapabilityReport, HelperStatus } from '@netschool/contracts';

// Helper hisoboti shu muddatdan eski bo'lsa, unga tayanilmaydi (helper har 5 s so'raydi, holatni o'zgarganda yoki
// davriy yuboradi).
export const HELPER_STATUS_FRESH_MS = 90_000;

type Capability = CapabilityReport['capabilities'][string];

const COMPONENTS = [
  ['hook', 'hook_failed'],
  ['policy', 'policy_failed'],
  ['processGuard', 'process_guard_failed'],
] as const;

// Overlay darajasi (P2d1, ADR 0014): `hard` faqat yangi helper hisobotida hook, siyosat va process guard uchalasi active
// bo'lsa. Aks holda `soft` + birinchi yiqilgan komponent; yiqilgan yo'q, lekin hammasi active emas (bloklash yo'q) —
// `lock_inactive`. Helper hisoboti yo'q yoki eski: Companion hisoboti, lekin hech qachon `hard` emas (`helper_missing`).
function overlay(entry: Capability, helper: HelperStatus | null): Capability {
  if (entry.state !== 'available') return entry;
  const { reason: _reason, ...rest } = entry;
  if (helper) {
    if (COMPONENTS.every(([key]) => helper[key] === 'active')) return { ...rest, enforcement: 'hard' };
    const failed = COMPONENTS.find(([key]) => helper[key] === 'failed');
    return { ...rest, enforcement: 'soft', reason: failed ? failed[1] : 'lock_inactive' };
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

// Panelga ko'rsatiladigan capability'lar: Companion hisoboti + helper holatidan hisoblangan daraja. Saqlangan hisobot
// o'zgarmaydi; hisob har o'qishda joriy vaqt bilan qilinadi.
export function effectiveCapabilities(
  report: CapabilityReport | null,
  helperStatus: unknown,
  helperStatusAt: Date | null,
  now: number,
): CapabilityReport | null {
  if (!report) return null;
  const fresh =
    helperStatus !== null && helperStatusAt !== null && now - helperStatusAt.getTime() <= HELPER_STATUS_FRESH_MS;
  const helper = fresh ? (helperStatus as HelperStatus) : null;
  const capabilities = { ...report.capabilities };
  const current = capabilities['classroom.overlay'];
  if (current) capabilities['classroom.overlay'] = overlay(current, helper);
  // Bu kalit faqat hub'niki (Companion yuborgani hisobga olinmaydi). Helper faqat Windows'da; boshqa OS'larda yo'q.
  delete capabilities['classroom.sas_block'];
  if (report.os === 'windows' || helper) capabilities['classroom.sas_block'] = sasBlock(helper);
  return { ...report, capabilities };
}
