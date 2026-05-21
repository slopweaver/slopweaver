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

/**
 * `prepare_send` is a two-step tool. The model calls it first without
 * `confirmed` (or with `confirmed: false`) to get the parsed routing
 * payload plus a `confirmation_token`. After the user OKs the 5-second
 * undo gate, the model re-invokes `prepare_send` with `confirmed: true`
 * and the matching token; only then does the response include the
 * executable `tool_args` for the downstream MCP send tool. This makes
 * "never auto-send without confirmation" a structural property of the
 * contract, not just prose in the instructions string.
 */
export const PrepareSendArgs = z
  .object({
    /** Absolute path to the draft file (frontmatter + body markdown). */
    draft_path: NonEmptyStringSchema,
    /** Set to `true` on the second call to release executable `tool_args`. */
    confirmed: z.boolean().optional(),
    /** Echo back the token returned on the first (unconfirmed) call. */
    confirmation_token: z.string().optional(),
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
    /**
     * Identifier of the downstream MCP server that hosts the send tool
     * (e.g. `"slack"`, `"github"`, `"gmail"`, `"linear"`). The model uses
     * this together with `tool_name` to pick the right `mcp__<server>__*`
     * tool to invoke.
     */
    server: NonEmptyStringSchema,
    /** Fully-qualified MCP tool name (e.g. `"slack_send_message"`). */
    tool_name: NonEmptyStringSchema,
    /**
     * Machine-readable args for `tool_name`. **Only populated on a
     * confirmed call** (`confirmed: true` + matching token). On the first
     * (unconfirmed) call this is omitted and `requires_confirmation` is
     * `true` — the model must surface the undo gate, await user OK, then
     * re-call `prepare_send` with the token to obtain executable args.
     */
    tool_args: z.record(z.string(), JsonValueSchema).optional(),
    /**
     * `true` when the response is the first-pass routing summary (no
     * executable args). `false` once the model has supplied a valid
     * `confirmation_token` and `tool_args` is populated.
     */
    requires_confirmation: z.boolean(),
    /**
     * Opaque token that the model must echo back as
     * `confirmation_token` on the second call. Present on both passes
     * (so the second-pass response can self-attest which token it
     * resolved). Tied to the draft's `content_hash` — re-issuing
     * `prepare_send` after the draft mutates (frontmatter OR body)
     * produces a new token and invalidates any previously-issued one.
     */
    confirmation_token: NonEmptyStringSchema,
    /**
     * Stable hash of the draft's full content (sorted-key frontmatter
     * `key: value\n` body, with `status` excluded, plus the trimmed
     * body). `record_send_outcome` requires the model to echo this
     * back; mismatch means the draft was edited between `prepare_send`
     * and `record_send_outcome` and the outcome is rejected as drift.
     * Body coverage is essential — without it, a model could edit the
     * draft text after the first `prepare_send`, send the edited body
     * on the confirmed call, and the calibration log would still
     * validate against the old hash.
     */
    content_hash: NonEmptyStringSchema,
    instructions: NonEmptyStringSchema,
    generated_at: IsoDatetimeSchema,
  })
  .strict();
export type PrepareSendResult = z.infer<typeof PrepareSendResult>;

/**
 * `record_send_outcome` enforces shape correlation per `status` via
 * `.superRefine`:
 *  - `sent` → `sent_url` is required (the source platform's
 *    permalink), `error` must be absent.
 *  - `failed` → `error` is required, `sent_url` must be absent.
 *  - `cancelled` → neither `sent_url` nor `error`.
 *
 * Every variant requires `draft_id` and `content_hash`. The tool
 * reads the draft from disk, validates the content still matches
 * (same `draft_id`, same hash over frontmatter + body), refuses to
 * overwrite a terminal status with a different terminal status, and
 * atomically rewrites the draft's `status:` field via temp-file +
 * rename before appending to the JSONL log. Repeat calls with the
 * same `(draft_id, status, content_hash)` are idempotent — the
 * existing log line is returned, no duplicate row is written.
 *
 * Implemented as a single `ZodObject` + `.superRefine` rather than a
 * `z.discriminatedUnion` because the MCP tool registry (see
 * `packages/mcp-server/src/tools/registry.ts`) constrains
 * `inputSchema` to `z.ZodObject` so the JSON-Schema export round-trips
 * cleanly through `tools/list`.
 */
export const RecordSendOutcomeArgs = z
  .object({
    /** Same draft_path that was passed to `prepare_send`. */
    draft_path: NonEmptyStringSchema,
    /** Echoed from the draft's frontmatter. Must match what's on disk. */
    draft_id: NonEmptyStringSchema,
    /** Echoed from the `PrepareSendResult.content_hash` field. */
    content_hash: NonEmptyStringSchema,
    status: z.enum(['sent', 'failed', 'cancelled']),
    /** Required when status='sent'. Source platform's permalink to the posted message. */
    sent_url: z.url().optional(),
    /** Required when status='failed'. */
    error: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'sent') {
      if (value.sent_url == null) {
        ctx.addIssue({
          code: 'custom',
          path: ['sent_url'],
          message: '`sent_url` is required when status="sent"',
        });
      }
      if (value.error != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: '`error` must be absent when status="sent"',
        });
      }
    } else if (value.status === 'failed') {
      if (value.error == null) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: '`error` is required when status="failed"',
        });
      }
      if (value.sent_url != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['sent_url'],
          message: '`sent_url` must be absent when status="failed"',
        });
      }
    } else {
      // status === 'cancelled'
      if (value.sent_url != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['sent_url'],
          message: '`sent_url` must be absent when status="cancelled"',
        });
      }
      if (value.error != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: '`error` must be absent when status="cancelled"',
        });
      }
    }
  });
export type RecordSendOutcomeArgs = z.infer<typeof RecordSendOutcomeArgs>;

export const RecordSendOutcomeResult = z
  .object({
    log_path: NonEmptyStringSchema,
    line_number: z.number().int().positive(),
    /** Final value written to the draft frontmatter's `status:` field. */
    draft_status: z.enum(['sent', 'failed', 'cancelled']),
  })
  .strict();
export type RecordSendOutcomeResult = z.infer<typeof RecordSendOutcomeResult>;
