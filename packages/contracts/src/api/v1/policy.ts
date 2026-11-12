import { normalizePattern, type RuleKey } from '@netschool/domain';
import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });

export const MAX_POLICY_PATTERNS = 500;

// Kiritilgan pattern normallashtiriladi; noto'g'risi validatsiya xatosi (regex/sxema/bo'sh joy yo'q).
export const urlPatternSchema = z.string().transform((value, ctx) => {
  const normalized = normalizePattern(value);
  if (normalized === null) {
    ctx.addIssue({ code: 'custom', message: 'invalid url pattern' });
    return z.NEVER;
  }
  return normalized;
});
const patternListSchema = z
  .array(urlPatternSchema)
  .max(MAX_POLICY_PATTERNS)
  .transform((list) => [...new Set(list)]);

const allowedDisabled = z.enum(['allowed', 'disabled']);

export const baselineDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  web: z.strictObject({ blocked: patternListSchema }).optional(),
  browser: z
    .strictObject({
      managed: z.boolean().optional(),
      incognito: allowedDisabled.optional(),
      devTools: allowedDisabled.optional(),
    })
    .optional(),
  os: z
    .strictObject({
      standardUser: z.boolean().optional(),
      blockAppInstall: z.boolean().optional(),
      lockWallpaper: z.boolean().optional(),
    })
    .optional(),
});

export const lessonDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  web: z.strictObject({ mode: z.enum(['off', 'allowlist', 'blocklist']), patterns: patternListSchema }),
});

export const effectiveBaselineSchema = z.object({
  web: z.object({ blocked: z.array(z.string()) }),
  browser: z.object({ managed: z.boolean(), incognito: allowedDisabled, devTools: allowedDisabled }),
  os: z.object({ standardUser: z.boolean(), blockAppInstall: z.boolean(), lockWallpaper: z.boolean() }),
});

export const policyVersionSchema = z.object({
  id: z.uuid(),
  layer: z.enum(['baseline', 'lesson']),
  siteId: z.uuid().nullable(),
  lessonId: z.uuid().nullable(),
  version: z.int().positive(),
  document: z.unknown(),
  contentHash: z.string(),
  createdBy: z.uuid(),
  createdAt: timestamp,
  restoredFrom: z.uuid().nullable(),
});
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

export const baselinePolicyResponseSchema = z.object({
  current: policyVersionSchema.nullable(),
  effective: effectiveBaselineSchema,
});
export const policyVersionsResponseSchema = z.object({ versions: z.array(policyVersionSchema) });
export const lessonPolicyResponseSchema = z.object({ current: policyVersionSchema.nullable() });

export const RULE_KEYS = [
  'web.blocked',
  'web.lesson',
  'browser.managed',
  'browser.incognito',
  'browser.devTools',
  'browser.onlyManaged',
  'os.standardUser',
  'os.blockAppInstall',
  'os.lockWallpaper',
] as const satisfies readonly RuleKey[];
