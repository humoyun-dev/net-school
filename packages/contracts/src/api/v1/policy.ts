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

// Bazaviy qatlam revision'i: tashkilot va site ko'lamlarining versiya raqami (0 — yo'q). Ikkalasi monoton.
export const baselineRevisionSchema = z.object({ org: z.int().min(0), site: z.int().min(0) });
export type BaselineRevision = z.infer<typeof baselineRevisionSchema>;
export const lessonRevisionSchema = z.object({ lessonId: z.uuid(), version: z.int().positive() });

// Heartbeat (Companion) va lock-state (Helper) javobidagi ishora: o'zgarsa qurilma to'liq siyosatni oladi.
export const policyHintSchema = z.object({ baseline: baselineRevisionSchema, lesson: lessonRevisionSchema.nullable() });
export type PolicyHint = z.infer<typeof policyHintSchema>;

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const deviceBaselineSchema = z.object({
  revision: baselineRevisionSchema,
  hash: hashSchema,
  document: effectiveBaselineSchema,
});
export const deviceLessonPolicySchema = z.object({
  lessonId: z.uuid(),
  version: z.int().positive(),
  hash: hashSchema,
  document: z.object({
    schemaVersion: z.literal(1),
    web: z.object({ mode: z.enum(['off', 'allowlist', 'blocklist']), patterns: z.array(z.string()) }),
  }),
  leaseSeconds: z.int().positive(),
});

// GET /api/v1/device/policy (Companion).
export const devicePolicySchema = z.object({
  baseline: deviceBaselineSchema,
  lesson: deviceLessonPolicySchema.nullable(),
});
export type DevicePolicy = z.infer<typeof devicePolicySchema>;

// Do'kon extension ID'si: 32 ta a–p harfi.
export const extensionIdSchema = z.string().regex(/^[a-p]{32}$/);
// GET /api/v1/device/helper/policy (Helper): faqat bazaviy qatlam va extension ID'lari.
export const helperPolicySchema = z.object({
  baseline: deviceBaselineSchema,
  extensions: z.object({ chrome: extensionIdSchema.nullable(), edge: extensionIdSchema.nullable() }),
});
export type HelperPolicy = z.infer<typeof helperPolicySchema>;

export const ruleKeySchema = z.enum(RULE_KEYS);
export const ruleResultSchema = z.strictObject({
  state: z.enum(['applied', 'failed', 'unsupported']),
  code: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
});
const rulesSchema = z.partialRecord(ruleKeySchema, ruleResultSchema);

// PUT /api/v1/device/policy/receipt va /device/helper/policy/receipt.
export const policyReceiptSchema = z.discriminatedUnion('layer', [
  z.strictObject({
    layer: z.literal('baseline'),
    revision: baselineRevisionSchema,
    hash: hashSchema,
    rules: rulesSchema,
    repaired: z.array(ruleKeySchema).max(RULE_KEYS.length).optional(),
  }),
  z.strictObject({
    layer: z.literal('lesson'),
    lessonId: z.uuid(),
    version: z.int().positive(),
    hash: hashSchema,
    rules: rulesSchema,
  }),
]);
export type PolicyReceipt = z.infer<typeof policyReceiptSchema>;

const layerStatusSchema = z.enum(['applied', 'partial', 'failed', 'pending']);
export const receiptViewSchema = z.object({
  applied: z.unknown(),
  status: z.enum(['applied', 'partial', 'failed']),
  rules: rulesSchema,
  reportedAt: timestamp,
});
export const policyStatusSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.uuid(),
      baseline: z.object({
        desired: baselineRevisionSchema,
        companion: receiptViewSchema.nullable(),
        helper: receiptViewSchema.nullable(),
        status: layerStatusSchema,
      }),
      lesson: z
        .object({ desired: lessonRevisionSchema, companion: receiptViewSchema.nullable(), status: layerStatusSchema })
        .nullable(),
    }),
  ),
});
export type PolicyStatus = z.infer<typeof policyStatusSchema>;
