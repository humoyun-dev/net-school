import type {
  DeviceBinding,
  DeviceEvent,
  DeviceSnapshot,
  EnrollmentResult,
  Unsubscribe,
  UpstreamDeviceRef,
} from '../devices.ts';
import type { PowerActionType } from '../power.ts';

// Server tayyorlagan, ruxsati tekshirilgan bitta node uchun quvvat so'rovi.
export interface AuthorizedPowerRequest {
  siteId: string;
  upstream: UpstreamDeviceRef;
  type: PowerActionType;
}

// accepted — MeshCentral qabul qildi (bajarilgani kuzatuv bilan aniqlanadi).
export type PowerRequestResult = { accepted: true } | { accepted: false; reason: 'wake_unsupported' | 'node_missing' };

// Spec §5.1 shartnomasi. Desktop sessiyalari alohida broker orqali (P1d); quvvat — P1h.
export interface DeviceManagementPort {
  listDevices(siteId: string): Promise<DeviceSnapshot[]>;
  // Node site scope'ida mavjudligini tekshiradi; upstream'da hech narsa o'zgartirmaydi.
  reconcileEnrollment(binding: DeviceBinding): Promise<EnrollmentResult>;
  subscribeDeviceEvents(handler: (event: DeviceEvent) => void): Unsubscribe;
  requestPowerAction(request: AuthorizedPowerRequest): Promise<PowerRequestResult>;
}
