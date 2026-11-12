import { policyStatusSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';

export interface TilePolicy {
  status: 'pending' | 'partial' | 'failed';
  reasons: string[];
}

const POLL_MS = 10_000;
const ORDER = ['failed', 'partial', 'pending', 'applied'] as const;

type Rules = Record<string, { state: string; code?: string }>;
const reasonsOf = (rules: Rules | undefined) =>
  Object.entries(rules ?? {})
    .filter(([, r]) => r.state !== 'applied')
    .map(([k, r]) => r.code ?? k);

// Xona qurilmalarining siyosat holati (har 10 s). Xato (ruxsat yo'q, hub eski) — belgisiz.
export function usePolicyStatus(roomId: string): Map<string, TilePolicy> {
  const api = useApi();
  const [byDevice, setByDevice] = useState<Map<string, TilePolicy>>(new Map());
  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      api
        .get(`/api/v1/policies/status?roomId=${roomId}`, policyStatusSchema, abort.signal)
        .then((r) => {
          const next = new Map<string, TilePolicy>();
          for (const d of r.devices) {
            const statuses = [d.baseline.status, ...(d.lesson ? [d.lesson.status] : [])];
            const status = ORDER.find((s) => statuses.includes(s)) ?? 'applied';
            if (status === 'applied') continue;
            const reasons = [
              ...reasonsOf(d.baseline.helper?.rules as Rules | undefined),
              ...reasonsOf(d.baseline.companion?.rules as Rules | undefined),
              ...reasonsOf(d.lesson?.companion?.rules as Rules | undefined),
            ];
            next.set(d.deviceId, { status, reasons: [...new Set(reasons)] });
          }
          setByDevice(next);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api, roomId]);
  return byDevice;
}
