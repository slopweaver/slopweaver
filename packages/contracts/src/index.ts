import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const IsoDatetimeSchema = z.iso.datetime({ offset: true });

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const PingArgs = z.object({}).strict();
export type PingArgs = z.infer<typeof PingArgs>;

export const PingResult = z
  .object({
    ok: z.literal(true),
    version: NonEmptyStringSchema,
    uptime_s: z.number().int().nonnegative(),
  })
  .strict();
export type PingResult = z.infer<typeof PingResult>;

export const Reference = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('url'),
      url: z.url(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('canonical'),
      integration: NonEmptyStringSchema,
      id: NonEmptyStringSchema,
    })
    .strict(),
]);
export type Reference = z.infer<typeof Reference>;

export const Freshness = z
  .object({
    integration: NonEmptyStringSchema,
    last_polled_at: IsoDatetimeSchema.nullable(),
    stale: z.boolean(),
  })
  .strict();
export type Freshness = z.infer<typeof Freshness>;

export const EvidenceLogEntry = z
  .object({
    id: NonEmptyStringSchema,
    integration: NonEmptyStringSchema,
    kind: NonEmptyStringSchema,
    ref: Reference,
    occurred_at: IsoDatetimeSchema,
    payload_json: JsonValueSchema,
    citation_url: z.url().nullable(),
  })
  .strict();
export type EvidenceLogEntry = z.infer<typeof EvidenceLogEntry>;

export const StartSessionArgs = z
  .object({
    integrations: z.array(NonEmptyStringSchema).min(1).optional(),
    max_items: z.number().int().positive().max(25).optional(),
    force_refresh: z.boolean().optional(),
  })
  .strict();
export type StartSessionArgs = z.infer<typeof StartSessionArgs>;

const StartSessionItemSchema = z
  .object({
    ref: Reference,
    priority: z.number().int().positive(),
    title: NonEmptyStringSchema,
    why: NonEmptyStringSchema,
    evidence_ids: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

export const StartSessionResult = z
  .object({
    items: z.array(StartSessionItemSchema),
    evidence: z.array(EvidenceLogEntry),
    freshness: z.array(Freshness),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type StartSessionResult = z.infer<typeof StartSessionResult>;

export const GetFreshnessArgs = z.object({}).strict();
export type GetFreshnessArgs = z.infer<typeof GetFreshnessArgs>;

export const GetFreshnessResult = z
  .object({
    freshness: z.array(Freshness),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type GetFreshnessResult = z.infer<typeof GetFreshnessResult>;

export const CatchMeUpArgs = z
  .object({
    since: IsoDatetimeSchema,
  })
  .strict();
export type CatchMeUpArgs = z.infer<typeof CatchMeUpArgs>;

export const CatchMeUpResult = z
  .object({
    evidence: z.array(EvidenceLogEntry),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type CatchMeUpResult = z.infer<typeof CatchMeUpResult>;

export const SearchWorkContextArgs = z
  .object({
    query: NonEmptyStringSchema,
    filters: z
      .object({
        integration: NonEmptyStringSchema.optional(),
        kind: NonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SearchWorkContextArgs = z.infer<typeof SearchWorkContextArgs>;

export const SearchWorkContextResult = z
  .object({
    evidence: z.array(EvidenceLogEntry),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type SearchWorkContextResult = z.infer<typeof SearchWorkContextResult>;

// --- Send-via-source (one-tap reply) ----------------------------------

export const PrepareSendArgs = z
  .object({
    /** Absolute path to the draft file (frontmatter + body markdown). */
    draft_path: NonEmptyStringSchema,
  })
  .strict();
export type PrepareSendArgs = z.infer<typeof PrepareSendArgs>;

const SendTargetSchema = z.discriminatedUnion('platform', [
  z
    .object({
      platform: z.literal('slack'),
      channel: NonEmptyStringSchema,
      thread_ts: z.string().optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal('github'),
      owner: NonEmptyStringSchema,
      repo: NonEmptyStringSchema,
      kind: z.enum(['pull', 'issue']),
      number: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      platform: z.literal('gmail'),
      thread_id: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      platform: z.literal('linear'),
      issue_id: NonEmptyStringSchema,
    })
    .strict(),
]);

export const PrepareSendResult = z
  .object({
    draft_id: z.string().optional(),
    target: SendTargetSchema,
    body: NonEmptyStringSchema,
    instructions: NonEmptyStringSchema,
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type PrepareSendResult = z.infer<typeof PrepareSendResult>;

export const RecordSendOutcomeArgs = z
  .object({
    /** Same draft_path that was passed to `prepare_send`. */
    draft_path: NonEmptyStringSchema,
    status: z.enum(['sent', 'failed', 'cancelled']),
    /** Required when status='sent'. Source platform's permalink to the posted message. */
    sent_url: z.url().optional(),
    /** Required when status='failed'. */
    error: z.string().optional(),
  })
  .strict();
export type RecordSendOutcomeArgs = z.infer<typeof RecordSendOutcomeArgs>;

export const RecordSendOutcomeResult = z
  .object({
    log_path: NonEmptyStringSchema,
    line_number: z.number().int().positive(),
  })
  .strict();
export type RecordSendOutcomeResult = z.infer<typeof RecordSendOutcomeResult>;
