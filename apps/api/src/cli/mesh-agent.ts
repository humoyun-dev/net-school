import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { sites } from '../db/schema.ts';
import { AuditWriter } from '../modules/audit/audit.writer.ts';
import type { CliEnv, ExitCode } from './types.ts';

const ARCHES = ['x64', 'arm64'] as const;
type Arch = (typeof ARCHES)[number];

// Site uchun Windows MeshAgent o'rnatuvchisi: guruh `NetSchool — <site>`, o'rnatuvchiga guruh .msh'i joylangan.
export async function meshAgentInstaller(argv: string[], env: CliEnv): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: { site: { type: 'string' }, arch: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  const arch = values.arch as Arch;
  const usage = 'usage: netschool-admin mesh-agent-installer --site <name> --arch x64|arm64 --out <file>\n';
  if (!values.site || !values.out || !ARCHES.includes(arch)) {
    env.stdout.write(usage);
    return 1;
  }
  const [site] = await env.db.select().from(sites).where(eq(sites.name, values.site));
  if (!site) {
    env.stdout.write(`site not found: ${values.site}\n`);
    return 1;
  }
  if (!env.meshAgents) {
    env.stdout.write(
      'MeshCentral is not configured (MESHCENTRAL_URL, MESHCENTRAL_USERNAME, MESHCENTRAL_PASSWORD, MESHCENTRAL_CA)\n',
    );
    return 2;
  }
  const group = `NetSchool — ${site.name}`;
  let installer: { meshid: string; bytes: Buffer };
  try {
    installer = await env.meshAgents.installer(group, arch);
  } catch (err) {
    env.stdout.write(
      `MeshCentral could not provide the agent: ${err instanceof Error ? err.message : String(err)}\n` +
        'If the agent binary is missing, run `pnpm meshcentral:agents` and rebuild the meshcentral image.\n',
    );
    return 2;
  }
  writeFileSync(values.out, installer.bytes);
  await env.db.transaction(async (tx) => {
    // Agent default domain'dagi guruhga o'rnatiladi: site hali bog'lanmagan bo'lsa shu domain'ga bog'lanadi.
    if (site.meshDomainId === null) await tx.update(sites).set({ meshDomainId: '' }).where(eq(sites.id, site.id));
    await new AuditWriter().write(
      tx,
      {
        organizationId: site.organizationId,
        siteId: site.id,
        actorUserId: null,
        action: 'mesh.agent_installer',
        targetType: 'site',
        targetId: site.id,
        result: 'succeeded',
        details: { via: 'cli', arch, meshid: installer.meshid, linkedDomain: site.meshDomainId === null },
      },
      randomUUID(),
    );
  });
  env.stdout.write(`${values.out}: ${installer.bytes.length} bytes, group "${group}", ${arch}\n`);
  return 0;
}
