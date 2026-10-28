// Upstream qurilma havolasi. Domain uchun shaffof emas: faqat adapter tarkibini talqin qiladi.
export interface UpstreamDeviceRef {
  meshInstanceId: string;
  meshDomainId: string;
  meshNodeId: string;
}

export type PowerState = 'on' | 'sleep' | 'off' | 'unknown';

export interface DeviceSnapshot {
  upstream: UpstreamDeviceRef;
  name: string;
  hostname: string | null;
  osDescription: string | null;
  agentOnline: boolean;
  powerState: PowerState;
}

export type DeviceEvent =
  | { type: 'device.connectivity'; upstream: UpstreamDeviceRef; agentOnline: boolean; powerState: PowerState }
  | { type: 'device.added' | 'device.changed' | 'device.removed'; upstream: UpstreamDeviceRef }
  | { type: 'resync' };

// Admin tasdiqlagan Companion qurilma ↔ MeshAgent node bog'lanishi (spec §6).
export interface DeviceBinding {
  siteId: string;
  deviceId: string;
  upstream: UpstreamDeviceRef;
}

export type EnrollmentResult = { status: 'bound'; snapshot: DeviceSnapshot } | { status: 'node_not_found' };

export type Unsubscribe = () => void;
