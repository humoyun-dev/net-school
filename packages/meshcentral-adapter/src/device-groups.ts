import type { MeshRequester } from './control-client.ts';
import { AdapterError } from './errors.ts';

// MeshCentral qurilma guruhi (mesh): agentlar shu guruhga o'rnatiladi. meshtype 2 — agent guruhi.
const AGENT_GROUP = 2;

interface MeshSummary {
  _id: string;
  name: string;
  mtype: number;
}

// Shu nomdagi agent guruhi bo'lsa o'sha, bo'lmasa yangisi (service account huquqi bilan).
export async function ensureDeviceGroup(client: MeshRequester, name: string): Promise<{ meshid: string }> {
  const reply = await client.request<{ meshes?: MeshSummary[] }>('meshes', {}, { correlate: 'tag' });
  const found = (reply.meshes ?? []).find((m) => m.name === name && m.mtype === AGENT_GROUP);
  if (found) return { meshid: found._id };
  const created = await client.request<{ meshid?: unknown }>('createmesh', { meshname: name, meshtype: AGENT_GROUP });
  if (typeof created.meshid !== 'string')
    throw new AdapterError('invalid_upstream_message', 'createmesh without meshid');
  return { meshid: created.meshid };
}

// MeshCentral agenttypes.js: 4 — Windows x86-64, 43 — Windows ARM-64. O'rnatuvchiga guruhning .msh'i joylanadi.
const WINDOWS_AGENT_ID = { x64: 4, arm64: 43 } as const;

export function agentDownloadPath(meshid: string, arch: keyof typeof WINDOWS_AGENT_ID): string {
  const match = /^mesh\/\/(.+)$/.exec(meshid);
  if (!match?.[1]) throw new AdapterError('scope_denied', 'Only device groups of the default domain are supported');
  return `/meshagents?id=${WINDOWS_AGENT_ID[arch]}&meshid=${encodeURIComponent(match[1])}&installflags=0`;
}
