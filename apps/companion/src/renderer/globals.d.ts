import type { NetschoolBridge } from '../preload/bridge.ts';

declare global {
  interface Window {
    netschool: NetschoolBridge;
  }
}
