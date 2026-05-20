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

// --- AI work console: branch enforcement + work-file CRUD ----------------

const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('..') && !value.startsWith('/'), {
    message: 'path must be relative and must not contain ".." segments',
  });

export const EnsureWorkConsoleBranchArgs = z
  .object({
    allow_switch_with_uncommitted: z.boolean().optional(),
  })
  .strict();
export type EnsureWorkConsoleBranchArgs = z.infer<typeof EnsureWorkConsoleBranchArgs>;

export const EnsureWorkConsoleBranchResult = z
  .object({
    branch: NonEmptyStringSchema,
    repo_root: NonEmptyStringSchema,
    /** What the helper actually did. */
    action: z.enum(['already_on_branch', 'switched', 'created_and_switched', 'no_git_repo']),
    /** Present when action is 'no_git_repo'; otherwise undefined. */
    message: z.string().optional(),
  })
  .strict();
export type EnsureWorkConsoleBranchResult = z.infer<typeof EnsureWorkConsoleBranchResult>;

export const GetWorkConsoleStateArgs = z.object({}).strict();
export type GetWorkConsoleStateArgs = z.infer<typeof GetWorkConsoleStateArgs>;

export const GetWorkConsoleStateResult = z
  .object({
    branch: NonEmptyStringSchema,
    repo_root: NonEmptyStringSchema.nullable(),
    console_dir: NonEmptyStringSchema,
    /** True when the user is currently on the work-console branch. */
    on_branch: z.boolean(),
    /** True when the console directory exists on disk. */
    initialized: z.boolean(),
    /** Sub-directories the console layout expects. Each entry includes whether the dir exists. */
    layout: z.array(
      z
        .object({
          path: NonEmptyStringSchema,
          exists: z.boolean(),
          kind: z.enum(['dir', 'file']),
          purpose: NonEmptyStringSchema,
        })
        .strict(),
    ),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type GetWorkConsoleStateResult = z.infer<typeof GetWorkConsoleStateResult>;

export const ReadConsoleFileArgs = z
  .object({
    path: RelativePathSchema,
  })
  .strict();
export type ReadConsoleFileArgs = z.infer<typeof ReadConsoleFileArgs>;

export const ReadConsoleFileResult = z
  .object({
    path: NonEmptyStringSchema,
    exists: z.boolean(),
    content: z.string().nullable(),
    bytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ReadConsoleFileResult = z.infer<typeof ReadConsoleFileResult>;

export const WriteConsoleFileArgs = z
  .object({
    path: RelativePathSchema,
    content: z.string(),
    /** Default true. When false, refuses to create a missing file. */
    create_if_missing: z.boolean().optional(),
  })
  .strict();
export type WriteConsoleFileArgs = z.infer<typeof WriteConsoleFileArgs>;

export const WriteConsoleFileResult = z
  .object({
    path: NonEmptyStringSchema,
    bytes_written: z.number().int().nonnegative(),
    created: z.boolean(),
  })
  .strict();
export type WriteConsoleFileResult = z.infer<typeof WriteConsoleFileResult>;

export const ListConsoleFilesArgs = z
  .object({
    /** Sub-path within the console dir. Defaults to the root. */
    subdir: RelativePathSchema.optional(),
  })
  .strict();
export type ListConsoleFilesArgs = z.infer<typeof ListConsoleFilesArgs>;

export const ListConsoleFilesResult = z
  .object({
    subdir: NonEmptyStringSchema,
    entries: z.array(
      z
        .object({
          path: NonEmptyStringSchema,
          kind: z.enum(['file', 'dir']),
          bytes: z.number().int().nonnegative().nullable(),
          modified_at: IsoDatetimeSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ListConsoleFilesResult = z.infer<typeof ListConsoleFilesResult>;

const WalkFeedbackOutcomeSchema = z.enum([
  'approved-as-proposed',
  'edited',
  'rejected',
  'deferred',
  'dropped',
  'noted',
  'walk-summary',
]);

const WalkFeedbackTotalsSchema = z
  .object({
    items: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    noted: z.number().int().nonnegative(),
  })
  .strict();

export const LogWalkFeedbackArgs = z
  .object({
    walk_id: NonEmptyStringSchema,
    item_index: z.number().int().nonnegative(),
    item_anchor: z.string().optional(),
    item_source: z.string().optional(),
    item_summary: z.string().optional(),
    proposed_action: z.string().optional(),
    user_action: z.string().optional(),
    outcome: WalkFeedbackOutcomeSchema,
    user_text: z.string().nullable().optional(),
    edit_diff: z.string().nullable().optional(),
    tags: z.array(NonEmptyStringSchema).optional(),
    /** Present only on the walk-summary line written when the walk stops. */
    totals: WalkFeedbackTotalsSchema.optional(),
    duration_minutes: z.number().nonnegative().optional(),
  })
  .strict();
export type LogWalkFeedbackArgs = z.infer<typeof LogWalkFeedbackArgs>;

export const LogWalkFeedbackResult = z
  .object({
    log_path: NonEmptyStringSchema,
    line_number: z.number().int().positive(),
    bytes_appended: z.number().int().nonnegative(),
  })
  .strict();
export type LogWalkFeedbackResult = z.infer<typeof LogWalkFeedbackResult>;

export const GetCalibrationReportArgs = z
  .object({
    /** Cutoff ISO datetime. Walks at or after this time are included. Defaults to last 30d. */
    since: IsoDatetimeSchema.optional(),
  })
  .strict();
export type GetCalibrationReportArgs = z.infer<typeof GetCalibrationReportArgs>;

export const GetCalibrationReportResult = z
  .object({
    window_start: IsoDatetimeSchema,
    window_end: IsoDatetimeSchema,
    total_walks: z.number().int().nonnegative(),
    total_items: z.number().int().nonnegative(),
    outcome_counts: z
      .object({
        'approved-as-proposed': z.number().int().nonnegative(),
        edited: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
        deferred: z.number().int().nonnegative(),
        dropped: z.number().int().nonnegative(),
        noted: z.number().int().nonnegative(),
      })
      .strict(),
    acceptance_rate: z.number().min(0).max(1),
    edit_rate: z.number().min(0).max(1),
    rejection_rate: z.number().min(0).max(1),
    top_friction_tags: z.array(
      z
        .object({
          tag: NonEmptyStringSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type GetCalibrationReportResult = z.infer<typeof GetCalibrationReportResult>;
