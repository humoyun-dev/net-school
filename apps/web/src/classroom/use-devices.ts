import { type Device, deviceSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';

const devicesResponseSchema = z.object({ devices: z.array(deviceSchema) });
const REFRESH_MS = 10_000;

// Qurilmalar holati (presence voqealari yo'q): har 10 s so'raladi.
export function useRoomDevices(roomId: string): Device[] {
  const api = useApi();
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      api
        .get(`/api/v1/rooms/${roomId}/devices`, devicesResponseSchema, abort.signal)
        .then((r) => setDevices(r.devices))
        .catch(() => {});
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api, roomId]);
  return devices;
}
