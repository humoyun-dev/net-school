// Spec §8: "hozir online" faqat heartbeat yangiligi bilan; last_seen tarixiy qiymat.
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_AFTER_MS = 30_000;

export type CompanionPresence = 'online' | 'stale' | 'never';

export function companionPresence(lastHeartbeatAt: number | null, now: number): CompanionPresence {
  if (lastHeartbeatAt === null) return 'never';
  return now - lastHeartbeatAt < STALE_AFTER_MS ? 'online' : 'stale';
}
