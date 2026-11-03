import type { PowerState } from './devices.ts';

// Markaziy quvvat boshqaruvi (spec §7.1, ADR 0010). Ijrochi — MeshAgent (adapter orqali).
export type PowerActionType = 'shutdown' | 'reboot' | 'sleep' | 'wake';
export type PowerTargetStatus = 'pending' | 'sent' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export type PowerFailureReason =
  | 'unbound'
  | 'device_offline'
  | 'wake_unsupported'
  | 'node_missing'
  | 'upstream_unavailable';
export type PowerActionStatus = 'scheduled' | 'running' | 'completed' | 'cancelled' | 'missed';

export const POWER_ACTION_TYPES: readonly PowerActionType[] = ['shutdown', 'reboot', 'sleep', 'wake'];
export const POWER_TARGET_STATUSES: readonly PowerTargetStatus[] = [
  'pending',
  'sent',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
];

// Ommaviy amal bosqichma-bosqich: bitta to'lqinda 50 qurilma, to'lqinlar orasida 5 s.
export const POWER_WAVE_SIZE = 50;
export const POWER_WAVE_INTERVAL_MS = 5_000;
// Shu muddatda kuzatuv natija bermasa target `unknown` (MeshCentral natijani tasdiqlamaydi).
export const POWER_OUTCOME_DEADLINE_MS: Readonly<Record<PowerActionType, number>> = {
  shutdown: 180_000,
  sleep: 180_000,
  reboot: 600_000,
  wake: 300_000,
};
// MeshCentral uzilgan bo'lsa yuborilmagan target shuncha kutadi, keyin `failed: upstream_unavailable`.
export const POWER_SEND_GIVE_UP_MS = 600_000;
// Vaqtidan shuncha kechikkan amal yoki jadval bajarilmaydi (`missed`): ertalab kechagi o'chirish bo'lmaydi.
export const POWER_MISSED_GRACE_MS = 600_000;
export const POWER_MAX_LEAD_MS = 30 * 86_400_000;

export interface PowerObservation {
  agentOnline: boolean;
  powerState: PowerState;
}

// Kuzatuvdan natija. observation null — node ro'yxatda yo'q (ma'lumot yo'q).
export function judgePowerTarget(
  type: PowerActionType,
  target: { sentAt: number; offlineSeenAt: number | null },
  observation: PowerObservation | null,
  now: number,
): { status: 'sent' | 'succeeded' | 'unknown'; offlineSeenAt: number | null } {
  let offlineSeenAt = target.offlineSeenAt;
  if (observation) {
    const { agentOnline, powerState } = observation;
    if (type === 'shutdown' && (!agentOnline || powerState === 'off')) return { status: 'succeeded', offlineSeenAt };
    if (type === 'sleep' && (!agentOnline || powerState === 'sleep')) return { status: 'succeeded', offlineSeenAt };
    if (type === 'wake' && agentOnline) return { status: 'succeeded', offlineSeenAt };
    if (type === 'reboot') {
      if (!agentOnline) offlineSeenAt ??= now;
      else if (offlineSeenAt !== null) return { status: 'succeeded', offlineSeenAt };
    }
  }
  const expired = now - target.sentAt >= POWER_OUTCOME_DEADLINE_MS[type];
  return { status: expired ? 'unknown' : 'sent', offlineSeenAt };
}

// Yumshoq o'chirish/qayta yuklashni Windows dasturi to'sib qo'yishi mumkin: shuncha vaqtdan keyin ham agent onlayn
// bo'lsa bir marta majburiy buyruq yuboriladi (saqlanmagan ish yo'qoladi; admin natijada `forcedAt` ni ko'radi).
export const POWER_FORCE_AFTER_MS = 60_000;

export function shouldForcePowerTarget(
  type: PowerActionType,
  target: { sentAt: number; offlineSeenAt: number | null; forcedAt: number | null },
  observation: PowerObservation | null,
  now: number,
): boolean {
  if (type !== 'shutdown' && type !== 'reboot') return false;
  if (target.forcedAt !== null || now - target.sentAt < POWER_FORCE_AFTER_MS) return false;
  if (!observation?.agentOnline || observation.powerState === 'off') return false;
  return type === 'shutdown' || target.offlineSeenAt === null;
}

// Majburiy buyruq oilasi; OS noma'lum bo'lsa null (majburiy bosqich o'tkazib yuboriladi).
export function powerPlatform(osDescription: string | null): 'windows' | 'posix' | null {
  if (!osDescription?.trim()) return null;
  return /windows/i.test(osDescription) ? 'windows' : 'posix';
}

export interface WeeklyRule {
  daysOfWeek: number[]; // 1 = dushanba … 7 = yakshanba
  timeOfDay: string; // 'HH:MM'
  timezone: string; // IANA
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DAY_MS = 86_400_000;
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  });
}

function localParts(fmt: Intl.DateTimeFormat, at: number): LocalParts & { second: number } {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY[p.weekday ?? ''] ?? 0,
  };
}

// Mintaqaning `at` lahzasidagi UTC offseti (ms).
function offsetAt(fmt: Intl.DateTimeFormat, at: number): number {
  const p = localParts(fmt, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

// Mahalliy devor vaqtini UTC lahzaga aylantiradi. DST oralig'ida (mavjud bo'lmagan vaqt) oldinga suriladi.
function wallToUtc(fmt: Intl.DateTimeFormat, wallAsUtc: number): number {
  const o1 = offsetAt(fmt, wallAsUtc);
  const t1 = wallAsUtc - o1;
  const o2 = offsetAt(fmt, t1);
  if (o1 === o2) return t1;
  const t2 = wallAsUtc - o2;
  const back = localParts(fmt, t2);
  const wall = new Date(wallAsUtc);
  if (back.hour === wall.getUTCHours() && back.minute === wall.getUTCMinutes()) return t2;
  return Math.max(t1, t2);
}

// afterMs dan qat'iy keyingi lahza: mahalliy hafta kuni rule'da va mahalliy vaqt = timeOfDay.
export function nextOccurrence(rule: WeeklyRule, afterMs: number): number {
  const [hh, mm] = rule.timeOfDay.split(':').map(Number) as [number, number];
  const fmt = formatter(rule.timezone);
  const start = localParts(fmt, afterMs);
  for (let i = 0; i <= 8; i++) {
    const dayUtc = Date.UTC(start.year, start.month - 1, start.day) + i * DAY_MS;
    const weekday = ((start.weekday - 1 + i) % 7) + 1;
    if (!rule.daysOfWeek.includes(weekday)) continue;
    const at = wallToUtc(fmt, dayUtc + (hh * 60 + mm) * 60_000);
    if (at > afterMs) return at;
  }
  throw new Error('no occurrence within 8 days');
}
