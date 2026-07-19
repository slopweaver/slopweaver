/**
 * Pure projection: raw GitHub items (+ their optional enriched activity) → `CorpusRecord[]`. No I/O, no
 * network — every network effect already happened in `fetch.ts`. One item fans out into: the PR/issue
 * **atom** (`#<n>`), one **review** record per review (`#<n>:review:<i>`), one **comment** record per
 * comment (`#<n>:comment:<i>`), and — when the timeline says so — one **state** record (`#<n>:state`)
 * carrying the latest lifecycle event. Child ids are index-stable across re-fetches (reviews/comments
 * are append-only), so dedup collapses re-ingested children onto the same lines.
 *
 * Redaction is NOT done here (the writer redacts before persisting); this stays a deterministic map so
 * the same input always yields the same records — a property dedup relies on.
 */

import { extractRefs } from "../refs.js";
import type { CorpusAttributeValue, CorpusKind, CorpusRecord } from "../types.js";
import type { GithubActivity } from "./activity.js";

export type GithubItemKind = "pr" | "issue";

/** A fetched GitHub item, before projection. `activity` is present iff enrichment ran for it. */
export interface GithubExportItem {
  readonly number: number;
  readonly kind: GithubItemKind;
  readonly title: string;
  readonly url: string;
  readonly tsIso: string;
  readonly author?: string;
  readonly body?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly activity?: GithubActivity;
}

/** A one-line status gate summary prepended to a PR's text, from the enriched activity. */
function gateSummary({ activity }: { activity: GithubActivity }): string {
  const parts: string[] = [];
  if (activity.reviewDecision !== undefined) {
    parts.push(`Review: ${activity.reviewDecision}`);
  }
  if (activity.mergeable !== undefined) {
    parts.push(`Mergeable: ${activity.mergeable}`);
  }
  if (activity.checks !== undefined) {
    parts.push(`Checks: ${activity.checks}`);
  }
  if (activity.isDraft === true) {
    parts.push("Draft");
  }
  return parts.join(" · ");
}

/** Rich structured metadata for a PR/issue atom — stored in bronze, kept OUT of the embedded text. */
function atomAttrs({ activity }: { activity: GithubActivity | undefined }): Record<string, CorpusAttributeValue> {
  const attrs: Record<string, CorpusAttributeValue> = {};
  if (activity === undefined) {
    return attrs;
  }
  if (activity.state.length > 0) {
    attrs["state"] = activity.state;
  }
  if (activity.reviewDecision !== undefined) {
    attrs["reviewDecision"] = activity.reviewDecision;
  }
  if (activity.mergeable !== undefined) {
    attrs["mergeable"] = activity.mergeable;
  }
  if (activity.checks !== undefined) {
    attrs["checks"] = activity.checks;
  }
  if (activity.isDraft !== undefined) {
    attrs["draft"] = activity.isDraft;
  }
  return attrs;
}

/** The PR/issue atom. State-prefixed title + (for PRs) a gate summary ahead of the body. */
function toAtom({ item, container }: { item: GithubExportItem; container: string }): CorpusRecord {
  const { activity } = item;
  const summary = activity !== undefined ? gateSummary({ activity }) : "";
  const text = [summary, item.body].filter((part) => part !== undefined && part.length > 0).join("\n\n");
  const state = activity?.state;
  const title = state !== undefined && state.length > 0 ? `[${state}] ${item.title}` : item.title;
  const attrs = atomAttrs({ activity });
  return {
    container,
    kind: item.kind,
    source: "github",
    sourceId: `#${String(item.number)}`,
    tsIso:
      activity?.updatedAtIso !== undefined && activity.updatedAtIso.length > 0 ? activity.updatedAtIso : item.tsIso,
    url: item.url,
    ...(item.author !== undefined ? { author: item.author } : {}),
    refs: extractRefs({
      text: [item.title, item.body].filter((part) => part !== undefined && part.length > 0).join("\n"),
    }),
    text: text.length > 0 ? text : item.title,
    title,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(item.raw !== undefined ? { raw: item.raw } : {}),
  };
}

function reviewRecords({ item, container }: { item: GithubExportItem; container: string }): CorpusRecord[] {
  const reviews = item.activity?.reviews ?? [];
  return reviews.map((review, index): CorpusRecord => {
    const text = review.body.trim().length > 0 ? review.body : `Review ${review.state}`;
    return {
      container,
      kind: "review",
      source: "github",
      sourceId: `#${String(item.number)}:review:${String(index)}`,
      tsIso: review.tsIso.length > 0 ? review.tsIso : item.tsIso,
      url: review.url.length > 0 ? review.url : item.url,
      ...(review.author !== undefined ? { author: review.author } : {}),
      refs: extractRefs({ text: review.body }),
      text,
      ...(review.raw !== undefined ? { raw: review.raw } : {}),
    };
  });
}

function commentRecords({ item, container }: { item: GithubExportItem; container: string }): CorpusRecord[] {
  const comments = item.activity?.comments ?? [];
  const records: CorpusRecord[] = [];
  comments.forEach((comment, index) => {
    if (comment.body.trim().length === 0) {
      return; // an empty comment carries nothing
    }
    const text = comment.resolved === true ? `[resolved] ${comment.body}` : comment.body;
    records.push({
      container,
      kind: "comment",
      source: "github",
      sourceId: `#${String(item.number)}:comment:${String(index)}`,
      tsIso: comment.tsIso.length > 0 ? comment.tsIso : item.tsIso,
      url: comment.url.length > 0 ? comment.url : item.url,
      ...(comment.author !== undefined ? { author: comment.author } : {}),
      refs: extractRefs({ text: comment.body }),
      text,
      ...(comment.raw !== undefined ? { raw: comment.raw } : {}),
    });
  });
  return records;
}

/** One `#<n>:state` record from the most-recent timeline event, when there is one. */
function stateRecord({ item, container }: { item: GithubExportItem; container: string }): CorpusRecord | undefined {
  const timeline = item.activity?.timeline ?? [];
  if (timeline.length === 0) {
    return undefined;
  }
  const latest = timeline.reduce((a, b) => (b.tsIso > a.tsIso ? b : a));
  const kind: CorpusKind = item.kind;
  const actor = latest.actor !== undefined ? ` by ${latest.actor}` : "";
  return {
    container,
    kind,
    refs: [],
    source: "github",
    sourceId: `#${String(item.number)}:state`,
    text: `${latest.type}${actor} · state: ${item.activity?.state ?? "unknown"}`,
    tsIso: latest.tsIso.length > 0 ? latest.tsIso : item.tsIso,
    url: item.url,
    ...(latest.raw !== undefined ? { raw: latest.raw } : {}),
  };
}

/**
 * Project every item into its atom + review/comment/state records.
 *
 * @param items the fetched items
 * @param repo the `owner/repo` container string
 * @returns the flattened corpus records
 */
export function projectGithubRecords({
  items,
  repo,
}: {
  items: readonly GithubExportItem[];
  repo: string;
}): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const item of items) {
    records.push(toAtom({ container: repo, item }));
    records.push(...reviewRecords({ container: repo, item }));
    records.push(...commentRecords({ container: repo, item }));
    const state = stateRecord({ container: repo, item });
    if (state !== undefined) {
      records.push(state);
    }
  }
  return records;
}
