import type { DeviceBinding, DeviceEvent, DeviceSnapshot, EnrollmentResult, Unsubscribe } from '../devices.ts';

// Spec §5.1 shartnomasi. openDesktopSession, closeDesktopSession va requestPowerAction
// mahsulot API'siga P1d'da ulanadi.
export interface DeviceManagementPort {
  listDevices(siteId: string): Promise<DeviceSnapshot[]>;
  // Node site scope'ida mavjudligini tekshiradi; upstream'da hech narsa o'zgartirmaydi.
  reconcileEnrollment(binding: DeviceBinding): Promise<EnrollmentResult>;
  subscribeDeviceEvents(handler: (event: DeviceEvent) => void): Unsubscribe;
}
