import type { UpstreamDeviceRef } from '@netschool/domain';
import { AdapterError } from './errors.ts';

// Bitta site bitta MeshCentral instance va domain'ga bog'langan. '' = default domain.
export interface SiteMeshScope {
  meshInstanceId: string;
  meshDomainId: string;
}

const NODE_ID = /^node\/([^/]*)\/([^/]+)$/;

export function parseNodeId(raw: string, scope: SiteMeshScope): UpstreamDeviceRef {
  const match = NODE_ID.exec(raw);
  if (!match) throw new AdapterError('invalid_upstream_message', `Invalid node id: ${raw}`);
  const [, domain = '', id = ''] = match;
  if (domain !== scope.meshDomainId) throw new AdapterError('scope_denied', 'Node belongs to another domain');
  return { meshInstanceId: scope.meshInstanceId, meshDomainId: domain, meshNodeId: id };
}

export function formatNodeId(ref: UpstreamDeviceRef): string {
  return `node/${ref.meshDomainId}/${ref.meshNodeId}`;
}
