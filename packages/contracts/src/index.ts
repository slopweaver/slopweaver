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

// --- Semantic recall over the evidence_log ---------------------------

export const RecallArgs = z
  .object({
    /** The natural-language query to match against evidence titles + bodies. */
    query: NonEmptyStringSchema,
    /** Max rows to return. 1–25; defaults to 10. */
    limit: z.number().int().positive().max(25).optional(),
    /** Optional filters; same shape as `search_work_context`. */
    filters: z
      .object({
        integration: NonEmptyStringSchema.optional(),
        kind: NonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RecallArgs = z.infer<typeof RecallArgs>;

const RecallHitSchema = z
  .object({
    evidence: EvidenceLogEntry,
    /**
     * Cosine similarity of query + evidence embeddings. The embedder
     * is contracted to return L2-normalized vectors, so this is the
     * true dot product in `[-1, 1]` — not a remapped/clamped variant.
     * The `recall` tool itself filters non-positive scores out before
     * returning, so in practice values are `(0, 1]`, but the wire
     * contract preserves the underlying range so a future embedder
     * that wants to expose anti-correlated hits doesn't need a
     * breaking schema change.
     */
    score: z.number().min(-1).max(1),
  })
  .strict();

export const RecallResult = z
  .object({
    hits: z.array(RecallHitSchema),
    generated_at: IsoDatetimeSchema,
    /** Marker for which embedder produced the scores — lets the live UI label the tab honestly. */
    embedder: NonEmptyStringSchema,
  })
  .strict();
export type RecallResult = z.infer<typeof RecallResult>;
