/**
 * The persona/profile seed persisted at `$SLOPWEAVER_HOME/profile.json`. Deliberately THIN and generic
 * for now (D3: built for me, dogfooded — not a generalised multi-user config): who the agent acts as,
 * the git namespace its PRs come from, and which sources it draws on. Later PRs (voice/persona, PR13)
 * grow it; PR1 only reserves the shape + a strict parser so a hand-edited file fails loudly, not silently.
 *
 * Validation is a Zod schema at the parse edge (per-field `error:` keeps the messages domain-specific and
 * leak-free). The public {@link Profile} type stays an explicit `readonly` interface — the house style for
 * a produced contract — with the schema kept in agreement. Pure: `parseProfile` narrows an already-parsed
 * JSON value, no I/O.
 */
import { z } from "zod";

import { err, ok, type Result } from "./lib/result.js";

/** The profile schema version; bump with a migration. A file at a different version is rejected, not coerced. */
export const PROFILE_SCHEMA_VERSION = 1;

const SOURCES_ERROR = "profile.json sources must be an array of strings";
const SLACK_BOT_ERROR = "profile.json slackBot must be an object with an ownerUserId string";

/** A string-array field with a shared domain error (used for the owner-bot id lists). */
const stringArray = z.array(z.string({ error: SLACK_BOT_ERROR }), { error: SLACK_BOT_ERROR });

/**
 * The OPTIONAL owner-bot declaration (PR4.5 me-to-me): the ids the owner's own Slack bot posts under, so a
 * bot-authored message resolves back to the owner. Every id list is optional (defaults empty). Absent ⇒
 * me-to-me is a no-op. Additive at schemaVersion 1 — a profile without it still validates.
 */
const slackBotSchema = z.object(
  {
    appIds: stringArray.default([]),
    botIds: stringArray.default([]),
    botUserIds: stringArray.default([]),
    ownerUserId: z.string({ error: SLACK_BOT_ERROR }),
  },
  { error: SLACK_BOT_ERROR },
);

/** The parse-edge schema. Object-level + per-field `error:` reproduce the domain-specific messages exactly. */
const profileSchema = z.object(
  {
    displayName: z.string({ error: "profile.json displayName must be a string" }),
    gitNamespace: z.string({ error: "profile.json gitNamespace must be a string" }),
    id: z.string({ error: "profile.json id must be a string" }),
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION, {
      error: (issue: { readonly input: unknown }) =>
        `profile.json schemaVersion must be ${String(PROFILE_SCHEMA_VERSION)}, got ${JSON.stringify(issue.input)}`,
    }),
    slackBot: slackBotSchema.optional(),
    sources: z.array(z.string({ error: SOURCES_ERROR }), { error: SOURCES_ERROR }),
  },
  { error: "profile.json is not a JSON object" },
);

/** The persona/profile seed. Fields are generic; empty strings are the un-set default. */
export interface Profile {
  /** Schema version — must equal {@link PROFILE_SCHEMA_VERSION}. */
  readonly schemaVersion: number;
  /** A stable local id for the persona the agent acts as (default `"me"`). */
  readonly id: string;
  /** Human display name for the persona (empty until set). */
  readonly displayName: string;
  /** The git author/namespace PRs and commits are attributed to (empty until set). */
  readonly gitNamespace: string;
  /** The corpus sources this profile draws on (e.g. `github`); empty until set. */
  readonly sources: readonly string[];
  /**
   * The owner's own Slack bot identity (PR4.5 me-to-me), when configured. Absent ⇒ me-to-me is off. Every
   * id list is optional (defaults empty at use). Never carries a real identifier in the repo — the seed
   * template ships blank and a real value lives only under `$SLOPWEAVER_HOME`.
   */
  readonly slackBot?: {
    readonly ownerUserId: string;
    readonly botUserIds: readonly string[];
    readonly appIds: readonly string[];
    readonly botIds: readonly string[];
  };
}

/**
 * Parse + validate an already-decoded JSON value into a {@link Profile}. Strict: a non-object, a wrong
 * `schemaVersion`, or a mistyped field is an error (so a corrupt hand-edit surfaces at read time).
 * Unknown extra fields are ignored — Zod strips them, matching the seed's forward-compatible intent.
 *
 * @param value a parsed JSON value (e.g. from `readJsonFile`)
 * @returns the validated profile, or an error listing every violation
 */
export function parseProfile({ value }: { value: unknown }): Result<Profile> {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) {
    return err(parsed.error.issues.map((issue) => issue.message));
  }
  const { displayName, gitNamespace, id, schemaVersion, sources, slackBot } = parsed.data;
  // Build the readonly contract explicitly: the optional `slackBot` is conditionally spread (so it never
  // reaches the value as an explicit `undefined` under exactOptionalPropertyTypes).
  return ok({
    displayName,
    gitNamespace,
    id,
    schemaVersion,
    sources,
    ...(slackBot !== undefined ? { slackBot } : {}),
  });
}
