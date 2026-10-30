import type { UpstreamDeviceRef } from './devices.ts';

// Masofaviy ish stoli sessiyasi rejimi: view = faqat ko'rish, control = boshqarish.
export type RemoteMode = 'view' | 'control';

// Gateway tomonidan allaqachon avtorizatsiyalangan ish stoli sessiyasi so'rovi.
export interface AuthorizedDesktopRequest {
  sessionId: string;
  actorId: string;
  device: UpstreamDeviceRef;
  mode: RemoteMode;
}

// Sessiya holati: opening → active → closed.
export type RemoteSessionStatus = 'opening' | 'active' | 'closed';

// Sessiya nega yopilgani (audit va UI uchun).
export type CloseReason =
  | 'teacher'
  | 'admin'
  | 'lesson_ended'
  | 'device_left'
  | 'lease_expired'
  | 'upstream_failed'
  | 'restart';

// Control sessiyasi lease muddati; teacher shu oraliqda yangilab turmasa sessiya yopiladi.
export const CONTROL_LEASE_MS = 30_000;
// Klient lease'ni shu oraliqda yangilaydi (lease ichida bir necha urinish sig'adi).
export const REMOTE_RENEW_INTERVAL_MS = 10_000;

// Rejimga mos ruxsat (action) nomi.
export function remoteAction(mode: RemoteMode): 'remote.view' | 'remote.control' {
  return mode === 'control' ? 'remote.control' : 'remote.view';
}
