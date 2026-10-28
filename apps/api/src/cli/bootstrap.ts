import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { organizations, roleAssignments, sites, users } from '../db/schema.ts';
import { AuditWriter } from '../modules/audit/audit.writer.ts';
import { hashPassword } from '../modules/identity/password.ts';
import type { CliEnv, ExitCode } from './types.ts';

export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function oneTimePassword(): string {
  return randomBytes(15).toString('base64url'); // 20 belgi
}

// Bo'sh hub'ni boshlang'ich holatga keltiradi: tashkilot, site va org-wide admin.
export async function bootstrap(argv: string[], env: CliEnv): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: {
      org: { type: 'string' },
      site: { type: 'string' },
      admin: { type: 'string' },
      'display-name': { type: 'string' },
    },
    strict: true,
  });
  const { org, site, admin } = values;
  if (!org || !site || !admin || !USERNAME.test(admin)) {
    env.stdout.write('usage: netschool-admin bootstrap --org <name> --site <name> --admin <username>\n');
    return 1;
  }
  const password = oneTimePassword();
  const passwordHash = await hashPassword(password);

  const created = await env.db.transaction(async (tx) => {
    if ((await tx.select({ id: organizations.id }).from(organizations).limit(1)).length > 0) return false;
    const [o] = await tx.insert(organizations).values({ name: org }).returning();
    if (!o) throw new Error('organization insert failed');
    await tx.insert(sites).values({ organizationId: o.id, name: site });
    const [u] = await tx
      .insert(users)
      .values({
        organizationId: o.id,
        username: admin,
        displayName: values['display-name'] ?? admin,
        passwordHash,
        mustChangePassword: true,
      })
      .returning();
    if (!u) throw new Error('user insert failed');
    await tx.insert(roleAssignments).values({ organizationId: o.id, userId: u.id, role: 'school_admin' });
    await new AuditWriter().write(
      tx,
      {
        organizationId: o.id,
        actorUserId: null,
        action: 'hub.bootstrap',
        targetType: 'user',
        targetId: u.id,
        result: 'succeeded',
        details: { via: 'cli' },
      },
      randomUUID(),
    );
    return true;
  });
  if (!created) {
    env.stdout.write('hub already has an organization; bootstrap refused\n');
    return 2;
  }
  env.stdout.write(
    `admin: ${admin}\npassword: ${password}\n(parol faqat shu yerda ko'rsatiladi; birinchi kirishda almashtiriladi)\n`,
  );
  return 0;
}
