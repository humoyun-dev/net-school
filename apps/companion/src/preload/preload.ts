import { contextBridge, ipcRenderer } from 'electron';
import type { NetschoolBridge } from './bridge.ts';

const subscribe =
  <T>(channel: string) =>
  (cb: (value: T) => void) => {
    const listener = (_event: unknown, value: T) => cb(value);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };

const bridge: NetschoolBridge = {
  onStatus: subscribe('status:update'),
  onMessage: subscribe('message:show'),
  raiseHelp: () => ipcRenderer.invoke('help:raise'),
  withdrawHelp: () => ipcRenderer.invoke('help:withdraw'),
  dismissMessage: (id) => ipcRenderer.send('message:dismiss', id),
  strings: () => ipcRenderer.invoke('i18n:strings'),
};

contextBridge.exposeInMainWorld('netschool', bridge);
