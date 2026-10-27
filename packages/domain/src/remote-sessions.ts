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
