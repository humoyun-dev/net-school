import type { DeviceEvent } from '@netschool/domain';
import { z } from 'zod';
import { isAgentOnline, toPowerState } from './map-nodes.ts';
import { parseNodeId, type SiteMeshScope } from './node-id.ts';

// addnode/changenode: nodeid event.node._id da; removenode/nodeconnect: event.nodeid da.
const eventSchema = z.object({
  action: z.literal('event'),
  event: z.object({
    action: z.string(),
    nodeid: z.string().optional(),
    node: z.object({ _id: z.string() }).optional(),
    conn: z.number().optional(),
    pwr: z.number().optional(),
  }),
});

const LIFECYCLE = {
  addnode: 'device.added',
  changenode: 'device.changed',
  removenode: 'device.removed',
} as const;

// Noma'lum yoki buzilgan xabar null qaytaradi: ulanish uzilmaydi, crash yo'q.
export function parseDeviceEvent(msg: unknown, scope: SiteMeshScope): DeviceEvent | null {
  const parsed = eventSchema.safeParse(msg);
  if (!parsed.success) return null;
  const { action, nodeid, node, conn, pwr } = parsed.data.event;
  const raw = nodeid ?? node?._id;
  if (raw === undefined) return null;
  let upstream: ReturnType<typeof parseNodeId>;
  try {
    upstream = parseNodeId(raw, scope);
  } catch {
    return null;
  }
  if (action === 'nodeconnect') {
    return { type: 'device.connectivity', upstream, agentOnline: isAgentOnline(conn), powerState: toPowerState(pwr) };
  }
  if (Object.hasOwn(LIFECYCLE, action)) return { type: LIFECYCLE[action as keyof typeof LIFECYCLE], upstream };
  return null;
}
