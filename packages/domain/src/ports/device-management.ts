import type { DeviceEvent, DeviceSnapshot, Unsubscribe } from '../devices.ts';

// Spec §5.1 shartnomasi. reconcileEnrollment, openDesktopSession, closeDesktopSession
// va requestPowerAction P0b/P1b'da qo'shiladi.
export interface DeviceManagementPort {
  listDevices(siteId: string): Promise<DeviceSnapshot[]>;
  subscribeDeviceEvents(handler: (event: DeviceEvent) => void): Unsubscribe;
}
