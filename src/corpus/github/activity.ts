/**
 * The GitHub activity lane: one GraphQL call per item enriches a PR/issue with its reviews, comments,
 * review-thread comments, CI status, and lifecycle timeline. The runner is an injected seam
 * (`GraphqlRunner`) so tests drive it with canned responses and the live client is built once in
 * `fetch.ts`. `parseActivity` is a pure, defensive parse — a malformed field degrades to empty, never
 * throws, so one weird item can't sink a whole refresh.
 */

import type { Repository } from "../../config.js";
import { isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";

export interface ActivityReview {
  readonly author?: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  readonly state: string;
  readonly tsIso: string;
  readonly url: string;
  readonly body: string;
}

export interface ActivityComment {
  readonly author?: string;
  readonly tsIso: string;
  readonly url: string;
  readonly body: string;
  /** Present only for review-thread comments: whether the thread is resolved. */
  readonly resolved?: boolean;
}

export interface ActivityStateEvent {
  /** Timeline `__typename` minus the trailing `Event` (e.g. `Merged`, `Closed`). */
  readonly type: string;
  readonly tsIso: string;
  readonly actor?: string;
}

export interface GithubActivity {
  readonly state: string;
  readonly isDraft?: boolean;
  readonly reviewDecision?: string;
  readonly mergeable?: string;
  /** Aggregate CI status-check-rollup state, when the head commit has one. */
  readonly checks?: string;
  readonly updatedAtIso: string;
  readonly reviews: readonly ActivityReview[];
  readonly comments: readonly ActivityComment[];
  readonly timeline: readonly ActivityStateEvent[];
}

/** The injected GraphQL transport: `(query, variables) => data`. Throws on network / GraphQL error. */
export type GraphqlRunner = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/** Fetch one item's activity. Returns `err` (never throws) so a single bad item is skippable. */
export type FetchGithubActivity = (input: {
  repo: Repository;
  number: number;
  isPr: boolean;
}) => Promise<Result<GithubActivity>>;

const PR_ACTIVITY_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      state isDraft updatedAt reviewDecision mergeable
      commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      reviews(first:100){nodes{author{login} state submittedAt url body}}
      comments(first:100){nodes{author{login} createdAt url body}}
      reviewThreads(first:100){nodes{isResolved comments(first:100){nodes{author{login} createdAt url body}}}}
      timelineItems(first:100,itemTypes:[MERGED_EVENT,CLOSED_EVENT,REOPENED_EVENT,READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT]){
        nodes{__typename
          ... on MergedEvent{createdAt actor{login}}
          ... on ClosedEvent{createdAt actor{login}}
          ... on ReopenedEvent{createdAt actor{login}}
          ... on ReadyForReviewEvent{createdAt actor{login}}
          ... on ConvertToDraftEvent{createdAt actor{login}}}}}}}`;

const ISSUE_ACTIVITY_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      state updatedAt
      comments(first:100){nodes{author{login} createdAt url body}}
      timelineItems(first:100,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]){
        nodes{__typename
          ... on ClosedEvent{createdAt actor{login}}
          ... on ReopenedEvent{createdAt actor{login}}}}}}}`;

/** Coerce an unknown to a string, or `''`. */
function str({ value }: { value: unknown }): string {
  return typeof value === "string" ? value : "";
}

/** Coerce an unknown to a non-empty string, or `undefined`. */
function optStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The `.nodes` array of a GraphQL connection, as records; `[]` for anything unexpected. */
function nodesOf({ connection }: { connection: unknown }): readonly Record<string, unknown>[] {
  if (!isRecord(connection) || !Array.isArray(connection["nodes"])) {
    return [];
  }
  return connection["nodes"].filter(isRecord);
}

/** The `login` off a GraphQL actor/author object, when present. */
function login({ actor }: { actor: unknown }): string | undefined {
  return isRecord(actor) ? optStr({ value: actor["login"] }) : undefined;
}

function parseReviews({ node }: { node: Record<string, unknown> }): ActivityReview[] {
  return nodesOf({ connection: node["reviews"] }).map((r) => {
    const author = login({ actor: r["author"] });
    return {
      ...(author !== undefined ? { author } : {}),
      body: str({ value: r["body"] }),
      state: str({ value: r["state"] }),
      tsIso: str({ value: r["submittedAt"] }),
      url: str({ value: r["url"] }),
    };
  });
}

function parseComments({ node }: { node: Record<string, unknown> }): ActivityComment[] {
  const issueComments: ActivityComment[] = nodesOf({ connection: node["comments"] }).map((c) => {
    const author = login({ actor: c["author"] });
    return {
      ...(author !== undefined ? { author } : {}),
      body: str({ value: c["body"] }),
      tsIso: str({ value: c["createdAt"] }),
      url: str({ value: c["url"] }),
    };
  });
  const threadComments: ActivityComment[] = nodesOf({ connection: node["reviewThreads"] }).flatMap((thread) => {
    const resolved = thread["isResolved"] === true;
    return nodesOf({ connection: thread["comments"] }).map((c) => {
      const author = login({ actor: c["author"] });
      return {
        ...(author !== undefined ? { author } : {}),
        body: str({ value: c["body"] }),
        resolved,
        tsIso: str({ value: c["createdAt"] }),
        url: str({ value: c["url"] }),
      };
    });
  });
  return [...issueComments, ...threadComments];
}

function parseTimeline({ node }: { node: Record<string, unknown> }): ActivityStateEvent[] {
  return nodesOf({ connection: node["timelineItems"] })
    .map((e) => {
      const actor = login({ actor: e["actor"] });
      return {
        ...(actor !== undefined ? { actor } : {}),
        tsIso: str({ value: e["createdAt"] }),
        type: str({ value: e["__typename"] }).replace(/Event$/, ""),
      };
    })
    .filter((e) => e.type.length > 0);
}

/** The CI rollup state off the last commit, when present. */
function checksOf({ node }: { node: Record<string, unknown> }): string | undefined {
  const commit = nodesOf({ connection: node["commits"] })[0];
  if (commit === undefined || !isRecord(commit["commit"])) {
    return undefined;
  }
  const rollup = commit["commit"]["statusCheckRollup"];
  return isRecord(rollup) ? optStr({ value: rollup["state"] }) : undefined;
}

/**
 * Shape a `pullRequest`/`issue` GraphQL node into a `GithubActivity`. Pure; never throws.
 *
 * @param node the GraphQL item node
 * @param isPr whether the node is a pull request (adds PR-only fields)
 * @returns the parsed activity
 */
export function parseActivity({ node, isPr }: { node: Record<string, unknown>; isPr: boolean }): GithubActivity {
  const checks = checksOf({ node });
  const mergeable = optStr({ value: node["mergeable"] });
  const reviewDecision = optStr({ value: node["reviewDecision"] });
  return {
    state: str({ value: node["state"] }),
    ...(isPr ? { isDraft: node["isDraft"] === true } : {}),
    ...(checks !== undefined ? { checks } : {}),
    comments: parseComments({ node }),
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    reviews: isPr ? parseReviews({ node }) : [],
    timeline: parseTimeline({ node }),
    updatedAtIso: str({ value: node["updatedAt"] }),
  };
}

/** Pull the item node out of a `repository { pullRequest|issue }` GraphQL response. */
function pickNode({ data, isPr }: { data: unknown; isPr: boolean }): Record<string, unknown> | undefined {
  if (!isRecord(data) || !isRecord(data["repository"])) {
    return undefined;
  }
  const node = isPr ? data["repository"]["pullRequest"] : data["repository"]["issue"];
  return isRecord(node) ? node : undefined;
}

/**
 * Build a `FetchGithubActivity` over an injected GraphQL runner.
 *
 * @param graphql the GraphQL transport
 * @returns a function that fetches one item's activity
 */
export function makeFetchGithubActivity({ graphql }: { graphql: GraphqlRunner }): FetchGithubActivity {
  return async ({ repo, number, isPr }) => {
    try {
      const data = await graphql(isPr ? PR_ACTIVITY_QUERY : ISSUE_ACTIVITY_QUERY, {
        number,
        owner: repo.owner,
        repo: repo.repo,
      });
      const node = pickNode({ data, isPr });
      if (node === undefined) {
        return err([`no ${isPr ? "pull request" : "issue"} #${String(number)} in GraphQL response`]);
      }
      return ok(parseActivity({ isPr, node }));
    } catch (error: unknown) {
      return err([error instanceof Error ? error.message : `activity fetch failed for #${String(number)}`]);
    }
  };
}
