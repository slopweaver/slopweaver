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

// --- Draft generator -------------------------------------------------

export const StartDraftArgs = z
  .object({
    /** Permalink to the thread / PR / ticket / email being replied to. */
    thread_ref: NonEmptyStringSchema,
    /** Optional one-line intent (e.g. "apologize for late chase", "request scope clarification"). */
    intent: z.string().optional(),
    /** Recipient identifier, used to pull stakeholder history via `recall` (when available). */
    stakeholder: z.string().optional(),
  })
  .strict();
export type StartDraftArgs = z.infer<typeof StartDraftArgs>;

export const StartDraftResult = z
  .object({
    /** Stable id the caller passes back into record-style tools. */
    draft_id: NonEmptyStringSchema,
    /** Slugified filename the draft will be saved under, e.g. "drafts/pr-12345-deploy-review.md". */
    suggested_path: NonEmptyStringSchema,
    /** Instructional body the model follows to draft the reply. */
    instructions: NonEmptyStringSchema,
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type StartDraftResult = z.infer<typeof StartDraftResult>;

// --- Weekly retro ----------------------------------------------------

export const StartRetroArgs = z
  .object({
    /** ISO date for the start of the retro window. Defaults to today minus 7 days. */
    since: z.iso.date().optional(),
  })
  .strict();
export type StartRetroArgs = z.infer<typeof StartRetroArgs>;

export const StartRetroResult = z
  .object({
    retro_id: NonEmptyStringSchema,
    since: z.iso.date(),
    instructions: NonEmptyStringSchema,
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type StartRetroResult = z.infer<typeof StartRetroResult>;

export const SnapshotProfileArgs = z
  .object({
    /**
     * Path to the source file. May be absolute or relative; relative
     * paths are resolved against `process.cwd()` by `snapshot_profile`.
     */
    source_path: NonEmptyStringSchema,
    /**
     * Override the snapshot filename. Defaults to a sortable
     * `<YYYY-MM-DDTHHMMSSZ>-<source-basename>` so same-day re-runs
     * produce distinct files rather than silently overwriting.
     *
     * Must be a single filename — no path separators (`/` or `\`), no
     * `..` segments, and not an absolute path. `snapshot_profile`
     * rejects anything that would resolve outside the
     * `<source-dir>/profile-snapshots/` directory.
     */
    snapshot_name: NonEmptyStringSchema.optional(),
    /**
     * When `true`, replace an existing snapshot at the resolved
     * destination. Defaults to `false`: `snapshot_profile` refuses to
     * write over an existing file so retros never silently destroy a
     * prior baseline.
     */
    overwrite: z.boolean().optional(),
  })
  .strict();
export type SnapshotProfileArgs = z.infer<typeof SnapshotProfileArgs>;

export const SnapshotProfileResult = z
  .object({
    snapshot_path: NonEmptyStringSchema,
    bytes_written: z.number().int().nonnegative(),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type SnapshotProfileResult = z.infer<typeof SnapshotProfileResult>;

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
    /** MCP-server slug (e.g. "slack", "github") associated with this event. Required when `phase === 'polling'` — every polling event must name the source it polled. */
    source: NonEmptyStringSchema.optional(),
    /** Free-form human-readable message. Surfaced verbatim in the UI tail. */
    message: NonEmptyStringSchema,
    /** Optional 0-100 progress hint for the current phase. */
    pct: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((value) => value.phase !== 'polling' || (value.source !== undefined && value.source.length > 0), {
    // Polling events fan out per MCP server, so the live UI tails them
    // grouped by source. A polling event with no `source` is a bug —
    // reject it at the schema boundary so the bug fails loudly instead
    // of silently rendering as "(unknown source)" in the UI.
    message: 'source is required when phase is "polling"',
    path: ['source'],
  });
export type RecordAuditProgressArgs = z.infer<typeof RecordAuditProgressArgs>;

export const RecordAuditProgressResult = z
  .object({
    log_path: NonEmptyStringSchema,
    bytes_appended: z.number().int().nonnegative(),
  })
  .strict();
export type RecordAuditProgressResult = z.infer<typeof RecordAuditProgressResult>;

// --- Voice rules post-processor ---------------------------------------

const VoiceRuleEditSchema = z
  .object({
    rule_line: z.number().int().positive(),
    kind: z.enum(['forbid_token', 'replace', 'disallow_pattern']),
    description: NonEmptyStringSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

export const ApplyVoiceRulesArgs = z
  .object({
    /** The draft to rewrite. */
    draft: z.string(),
    /** The contents of `rules/communication-style.md` (or equivalent). Parsed in-tool. */
    rules_markdown: z.string(),
  })
  .strict();
export type ApplyVoiceRulesArgs = z.infer<typeof ApplyVoiceRulesArgs>;

export const ApplyVoiceRulesResult = z
  .object({
    rewritten: z.string(),
    edits: z.array(VoiceRuleEditSchema),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type ApplyVoiceRulesResult = z.infer<typeof ApplyVoiceRulesResult>;

// --- Semantic recall over the evidence_log ---------------------------

export const RecallArgs = z
  .object({
    /** The natural-language query to match against evidence titles + bodies. */
    query: NonEmptyStringSchema,
    /** Max rows to return. 1-25; defaults to 10. */
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
     * true dot product in `[-1, 1]`, not a remapped/clamped variant.
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
    /** Marker for which embedder produced the scores. */
    embedder: NonEmptyStringSchema,
  })
  .strict();
export type RecallResult = z.infer<typeof RecallResult>;
