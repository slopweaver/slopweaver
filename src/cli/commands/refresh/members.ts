/**
 * The member-hydration edge of `refresh`: after activity ingest, enumerate each selected source's members
 * (official SDKs, behind the same injected seams the activity lanes use) and persist them to member bronze.
 * Read-only + additive to activity: a hydration failure is WARNING-only — it never flips the refresh exit
 * code — so a capability/scope gap (e.g. no Slack email scope, a non-SAML GitHub org) degrades gracefully
 * instead of sinking the whole refresh. The resolver then auto-links the team cross-source on the next
 * `derive` / `identity show`.
 */
import { fetchGithubMembers, makeGithubMembersApi } from "../../../corpus/github/members.js";
import { fetchLinearMembers, makeLinearApi } from "../../../corpus/linear/fetch.js";
import { writeMemberRows } from "../../../corpus/members/store.js";
import type { MemberBronzeRow } from "../../../corpus/members/types.js";
import { fetchNotionMembers, makeNotionApi } from "../../../corpus/notion/fetch.js";
import { fetchSlackMembers, makeSlackApi } from "../../../corpus/slack/fetch.js";
import type { CorpusSource } from "../../../corpus/types.js";
import type { Result } from "../../../lib/result.js";
import type { IdentitySource } from "../../../silver/identity.js";
import type { RefreshSummaryLine } from "./core.js";

/** One source's member-hydration outcome (folded into the refresh summary, never the exit code). */
export interface MemberHydrationResult {
  readonly source: IdentitySource;
  readonly ok: boolean;
  readonly hydrated: number;
  readonly written: number;
  readonly deduped: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/** The tokens the hydration lanes need (Slack read token / Linear / Notion / GitHub). */
export interface MemberTokens {
  readonly slack?: string;
  readonly linear?: string;
  readonly notion?: string;
  readonly github?: string;
}

/** A fetched member result the persist step consumes. */
type FetchedMembers = Result<{ rows: readonly MemberBronzeRow[]; warnings: readonly string[] }>;

/** Write a source's fetched members to member bronze, folding the counts + warnings into a result. */
function persist({
  source,
  fetched,
  home,
}: {
  source: IdentitySource;
  fetched: FetchedMembers;
  home: string;
}): MemberHydrationResult {
  if (fetched.ok === false) {
    return { deduped: 0, errors: fetched.errors, hydrated: 0, ok: false, source, warnings: [], written: 0 };
  }
  const { rows, warnings } = fetched.value;
  const wrote = writeMemberRows({ home, rows, source });
  if (wrote.ok === false) {
    return { deduped: 0, errors: wrote.errors, hydrated: rows.length, ok: false, source, warnings, written: 0 };
  }
  return {
    deduped: wrote.value.deduped,
    errors: [],
    hydrated: rows.length,
    ok: true,
    source,
    warnings,
    written: wrote.value.written,
  };
}

/**
 * Hydrate ONE source's members over its live seam (undefined ⇒ not hydratable: gold, or no token/org).
 * Effectful — the injected connector seams do the network.
 *
 * @param source the source to hydrate
 * @param home the world-model home
 * @param fetchedAtIso the hydration timestamp
 * @param tokens the per-source tokens
 * @param githubOrg the GitHub org (repo owner), when GitHub is selected + resolvable
 * @returns the hydration result, or `undefined` when the source isn't hydratable
 */
export async function hydrateOneSource({
  source,
  home,
  fetchedAtIso,
  tokens,
  githubOrg,
}: {
  source: CorpusSource;
  home: string;
  fetchedAtIso: string;
  tokens: MemberTokens;
  githubOrg?: string;
}): Promise<MemberHydrationResult | undefined> {
  if (source === "slack" && tokens.slack !== undefined) {
    return persist({
      fetched: await fetchSlackMembers({ api: makeSlackApi({ token: tokens.slack }), fetchedAtIso }),
      home,
      source,
    });
  }
  if (source === "linear" && tokens.linear !== undefined) {
    return persist({
      fetched: await fetchLinearMembers({ api: makeLinearApi({ token: tokens.linear }), fetchedAtIso }),
      home,
      source,
    });
  }
  if (source === "notion" && tokens.notion !== undefined) {
    return persist({
      fetched: await fetchNotionMembers({ api: makeNotionApi({ token: tokens.notion }), fetchedAtIso }),
      home,
      source,
    });
  }
  if (source === "github" && githubOrg !== undefined) {
    const fetched = await fetchGithubMembers({
      api: makeGithubMembersApi({ token: tokens.github }),
      fetchedAtIso,
      org: githubOrg,
    });
    return persist({ fetched, home, source });
  }
  return undefined;
}

/**
 * The member-hydration summary lines (WARN for failures/warnings, OUT for successes) — hydration never
 * fails the verb, so nothing here is an `error` level. Pure.
 *
 * @param results the per-source hydration results
 * @returns the ordered summary lines
 */
export function summariseMemberHydration({
  results,
}: {
  results: readonly MemberHydrationResult[];
}): readonly RefreshSummaryLine[] {
  const lines: RefreshSummaryLine[] = [];
  for (const result of results) {
    for (const warning of result.warnings) {
      lines.push({ level: "warn", text: `  members ${result.source}: ${warning}` });
    }
    if (result.ok === false) {
      for (const error of result.errors) {
        lines.push({ level: "warn", text: `  members ${result.source}: ${error}` });
      }
      continue;
    }
    lines.push({
      level: "out",
      text: `members ${result.source}: hydrated ${String(result.hydrated)} (wrote ${String(result.written)} new, deduped ${String(result.deduped)})`,
    });
  }
  return lines;
}
