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

// --- Mega-audit ------------------------------------------------------

export const StartMegaAuditArgs = z
  .object({
    /** ISO date — start of the lookback window. Defaults to today minus 90 days. */
    since: z.iso.date().optional(),
    /** Override the per-source token budget for the aggregate context. Default: 90_000 tokens per source. */
    per_source_token_budget: z.number().int().positive().max(200_000).optional(),
  })
  .strict();
export type StartMegaAuditArgs = z.infer<typeof StartMegaAuditArgs>;

export const StartMegaAuditResult = z
  .object({
    /** Stable id the caller should pass to every `record_audit_progress` call during this run. */
    audit_id: NonEmptyStringSchema,
    /** Instructional body the model should follow to execute the audit. */
    instructions: NonEmptyStringSchema,
    /** Effective lookback window in ISO date. */
    since: z.iso.date(),
    /** Effective per-source token budget the model should respect when batching. */
    per_source_token_budget: z.number().int().positive(),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type StartMegaAuditResult = z.infer<typeof StartMegaAuditResult>;

// --- Mega-audit progress streaming -----------------------------------

const AuditPhaseSchema = z.enum([
  'starting',
  'inventory',
  'polling',
  'aggregating',
  'synthesizing',
  'writing',
  'completed',
  'failed',
]);

export const RecordAuditProgressArgs = z
  .object({
    /** Audit run identifier. Generate once at the top of the audit; reuse for every progress event. */
    audit_id: NonEmptyStringSchema,
    phase: AuditPhaseSchema,
    /** Optional MCP-server slug (e.g. "slack", "github") associated with this event. */
    source: NonEmptyStringSchema.optional(),
    /** Free-form human-readable message. Surfaced verbatim in the UI tail. */
    message: NonEmptyStringSchema,
    /** Optional 0-100 progress hint for the current phase. */
    pct: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type RecordAuditProgressArgs = z.infer<typeof RecordAuditProgressArgs>;

export const RecordAuditProgressResult = z
  .object({
    log_path: NonEmptyStringSchema,
    line_number: z.number().int().positive(),
    bytes_appended: z.number().int().nonnegative(),
  })
  .strict();
export type RecordAuditProgressResult = z.infer<typeof RecordAuditProgressResult>;
