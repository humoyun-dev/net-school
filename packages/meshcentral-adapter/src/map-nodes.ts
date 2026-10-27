import type { DeviceSnapshot, PowerState } from '@netschool/domain';
import { z } from 'zod';
import { AdapterError } from './errors.ts';
import { parseNodeId, type SiteMeshScope } from './node-id.ts';

// Offline qurilmada conn/pwr/osdesc umuman kelmaydi (probe fixture).
const nodeSchema = z.object({
  _id: z.string(),
  name: z.string(),
  host: z.string().optional(),
  osdesc: z.string().optional(),
  conn: z.number().optional(),
  pwr: z.number().optional(),
});

const nodesResponseSchema = z.object({ nodes: z.record(z.string(), z.array(nodeSchema)) });

const CONN_AGENT = 1;

export function isAgentOnline(conn: number | undefined): boolean {
  return ((conn ?? 0) & CONN_AGENT) === CONN_AGENT;
}

// pwr: 1 = on; 2-5 = sleep/hibernate; 6 = soft-off; boshqasi noma'lum.
export function toPowerState(pwr: number | undefined): PowerState {
  if (pwr === 1) return 'on';
  if (pwr !== undefined && pwr >= 2 && pwr <= 5) return 'sleep';
  if (pwr === 6) return 'off';
  return 'unknown';
}

export function mapNodesResponse(msg: unknown, scope: SiteMeshScope): DeviceSnapshot[] {
  const parsed = nodesResponseSchema.safeParse(msg);
  if (!parsed.success) throw new AdapterError('invalid_upstream_message', 'Malformed nodes response', parsed.error);
  const snapshots: DeviceSnapshot[] = [];
  for (const node of Object.values(parsed.data.nodes).flat()) {
    let upstream: DeviceSnapshot['upstream'];
    try {
      upstream = parseNodeId(node._id, scope);
    } catch (err) {
      if (err instanceof AdapterError && err.code === 'scope_denied') continue;
      throw err;
    }
    snapshots.push({
      upstream,
      name: node.name,
      hostname: node.host ?? null,
      osDescription: node.osdesc ?? null,
      agentOnline: isAgentOnline(node.conn),
      powerState: toPowerState(node.pwr),
    });
  }
  return snapshots;
}
