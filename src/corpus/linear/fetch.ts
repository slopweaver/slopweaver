/**
 * The impure Linear edge. To avoid an N+1 request explosion (the lazy `@linear/sdk` relations are one
 * GraphQL request EACH — ~7 per issue, thousands on a backfill → Linear's 2,500/hr cap), we issue ONE
 * inline GraphQL query per issue-PAGE that pulls each issue WITH its state/assignee/creator/team/project/
 * labels AND its first page of comments; only issues with more than one comment page cost an extra call.
 * So a page of N issues is ~1 request, not ~7N. Every request is paced by a shared {@link RateBucket}
 * (well under 2,500/hr) and wrapped in {@link retry} so a transient 5xx/429/network blip self-heals.
 *
 * The GraphQL transport is an INJECTED seam (`LinearRequest`) — production uses the SDK client's
 * `rawRequest`; tests inject a fake that counts requests + returns fixture data. The node parse
 * (`parseLinearIssueNode`) is pure and separately tested; `project.ts` consumes the same shaped items.
 */
import { LinearClient } from "@linear/sdk";

import { isRecord } from "../../lib/parsers.js";
import { RateBucket } from "../../lib/rateBucket.js";
import { err, ok, type Result } from "../../lib/result.js";
import { retry } from "../../lib/retry.js";
import type { ExportWindow } from "../types.js";
import type { LinearCommentItem, LinearIssueItem, LinearProjectItem } from "./project.js";

const PAGE_SIZE = 50;
const COMMENTS_PAGE_SIZE = 50;
/** Well under Linear's ~2,500 req/hr (~0.69/s) cap so a backfill paces itself instead of self-cap-failing. */
const LINEAR_RATE_PER_SEC = 0.5;

const ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt
  state { name }
  assignee { displayName }
  creator { displayName }
  team { key }
  project { name }
  labels(first: 30) { nodes { name } }
  comments(first: ${String(COMMENTS_PAGE_SIZE)}) {
    nodes { id body url createdAt user { displayName } }
    pageInfo { hasNextPage endCursor }
  }
`;

const ISSUES_QUERY = `
query Issues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_COMMENTS_QUERY = `
query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: ${String(COMMENTS_PAGE_SIZE)}, after: $after) {
      nodes { id body url createdAt user { displayName } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PROJECTS_QUERY = `
query Projects($filter: ProjectFilter, $first: Int!, $after: String) {
  projects(filter: $filter, first: $first, after: $after) {
    nodes { id name description url updatedAt state }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** A page of shaped issues from the seam. */
export interface LinearIssuesPage {
  readonly issues: readonly LinearIssueItem[];
  readonly nextCursor?: string;
}

/** A page of shaped projects from the seam. */
export interface LinearProjectsPage {
  readonly projects: readonly LinearProjectItem[];
  readonly nextCursor?: string;
}

/** Injected Linear seam — returns fully-resolved shaped items so `fetchLinearActivity` needs no live SDK. */
export interface LinearApi {
  issues: (args: { since: string; cursor?: string }) => Promise<LinearIssuesPage>;
  projects: (args: { since: string; cursor?: string }) => Promise<LinearProjectsPage>;
}

/** The raw GraphQL transport seam: one inline query → its `data`. Production uses the SDK's rawRequest. */
export type LinearRequest = (args: { query: string; variables: Record<string, unknown> }) => Promise<unknown>;

/**
 * Fetch all issues (+ comments) and projects updated since the window's `since`, paging both to
 * exhaustion. A failure at either top-level lane is fatal (after `retry` has exhausted its budget).
 *
 * @param api the injected Linear seam
 * @param window the export window (`since` is the `updatedAt >= ` bound)
 * @returns the shaped issues + projects, or `err` on a fatal failure
 */
export async function fetchLinearActivity({
  api,
  window,
}: {
  api: LinearApi;
  window: ExportWindow;
}): Promise<Result<{ issues: readonly LinearIssueItem[]; projects: readonly LinearProjectItem[] }>> {
  const issues: LinearIssueItem[] = [];
  const projects: LinearProjectItem[] = [];
  try {
    let issueCursor: string | undefined;
    do {
      const page = await api.issues({
        since: window.since,
        ...(issueCursor !== undefined ? { cursor: issueCursor } : {}),
      });
      issues.push(...page.issues);
      issueCursor = page.nextCursor;
    } while (issueCursor !== undefined && issueCursor.length > 0);

    let projectCursor: string | undefined;
    do {
      const page = await api.projects({
        since: window.since,
        ...(projectCursor !== undefined ? { cursor: projectCursor } : {}),
      });
      projects.push(...page.projects);
      projectCursor = page.nextCursor;
    } while (projectCursor !== undefined && projectCursor.length > 0);
  } catch (error: unknown) {
    return err([`fetch failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  return ok({ issues, projects });
}

/** A non-empty string field, or undefined. */
function str({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A required string field parsed from an external node: the string, or "" when absent (honest sentinel). */
function strOrEmpty({ value }: { value: unknown }): string {
  return typeof value === "string" ? value : "";
}

/** `displayName` off a nested user-like object. */
function displayName({ value }: { value: unknown }): string | undefined {
  return isRecord(value) ? str({ value: value["displayName"] }) : undefined;
}

/** Parse a `comments` connection's nodes into shaped comment items. */
function parseComments({ nodes }: { nodes: unknown }): readonly LinearCommentItem[] {
  if (!Array.isArray(nodes)) {
    return [];
  }
  const comments: LinearCommentItem[] = [];
  for (const raw of nodes) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = str({ value: raw["id"] });
    const body = str({ value: raw["body"] });
    if (id === undefined || body === undefined) {
      continue;
    }
    const author = displayName({ value: raw["user"] });
    comments.push({
      body,
      id,
      tsIso: strOrEmpty({ value: raw["createdAt"] }),
      url: strOrEmpty({ value: raw["url"] }),
      ...(author !== undefined ? { author } : {}),
    });
  }
  return comments;
}

/** Label names off a `labels` connection. */
function parseLabels({ connection }: { connection: unknown }): readonly string[] {
  if (!isRecord(connection) || !Array.isArray(connection["nodes"])) {
    return [];
  }
  return connection["nodes"]
    .map((node) => (isRecord(node) ? str({ value: node["name"] }) : undefined))
    .filter((name): name is string => name !== undefined);
}

/** The pageInfo `{ hasNextPage, endCursor }` off a connection. */
function pageInfoOf({ connection }: { connection: unknown }): { hasNext: boolean; endCursor?: string } {
  const info = isRecord(connection) ? connection["pageInfo"] : undefined;
  if (!isRecord(info)) {
    return { hasNext: false };
  }
  const endCursor = str({ value: info["endCursor"] });
  return { hasNext: info["hasNextPage"] === true, ...(endCursor !== undefined ? { endCursor } : {}) };
}

/**
 * Parse one raw inline GraphQL issue node into a shaped item + its comment-pagination state. Pure — a
 * node from an older/partial query still parses (missing relations simply drop out).
 *
 * @param node the raw issue node
 * @returns the shaped item + its id + whether comments have another page, or undefined when unusable
 */
export function parseLinearIssueNode({ node }: { node: unknown }):
  | {
      item: LinearIssueItem;
      id: string;
      commentsHasNext: boolean;
      commentsCursor?: string;
    }
  | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const identifier = str({ value: node["identifier"] });
  if (identifier === undefined) {
    return undefined;
  }
  const id = str({ value: node["id"] }) ?? identifier;
  const description = str({ value: node["description"] });
  const author = displayName({ value: node["creator"] });
  const assignee = displayName({ value: node["assignee"] });
  const state = isRecord(node["state"]) ? str({ value: node["state"]["name"] }) : undefined;
  const team = isRecord(node["team"]) ? str({ value: node["team"]["key"] }) : undefined;
  const project = isRecord(node["project"]) ? str({ value: node["project"]["name"] }) : undefined;
  const commentsPage = pageInfoOf({ connection: node["comments"] });
  const item: LinearIssueItem = {
    comments: parseComments({ nodes: isRecord(node["comments"]) ? node["comments"]["nodes"] : undefined }),
    identifier,
    labels: parseLabels({ connection: node["labels"] }),
    title: str({ value: node["title"] }) ?? identifier,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(team !== undefined ? { team } : {}),
    ...(project !== undefined ? { project } : {}),
  };
  return {
    commentsHasNext: commentsPage.hasNext,
    id,
    item,
    ...(commentsPage.endCursor !== undefined ? { commentsCursor: commentsPage.endCursor } : {}),
  };
}

/** Paginate an issue's remaining comment pages (only issues with >1 page reach here). */
async function remainingComments({
  call,
  id,
  after,
}: {
  call: LinearRequest;
  id: string;
  after: string;
}): Promise<readonly LinearCommentItem[]> {
  const comments: LinearCommentItem[] = [];
  let cursor: string | undefined = after;
  while (cursor !== undefined) {
    const data = await call({ query: ISSUE_COMMENTS_QUERY, variables: { after: cursor, id } });
    const connection = isRecord(data) && isRecord(data["issue"]) ? data["issue"]["comments"] : undefined;
    comments.push(...parseComments({ nodes: isRecord(connection) ? connection["nodes"] : undefined }));
    const info = pageInfoOf({ connection });
    cursor = info.hasNext ? info.endCursor : undefined;
  }
  return comments;
}

/** Shape one project node. */
function parseProject({ node }: { node: unknown }): LinearProjectItem | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const id = str({ value: node["id"] });
  const name = str({ value: node["name"] });
  if (id === undefined || name === undefined) {
    return undefined;
  }
  const description = str({ value: node["description"] });
  const state = str({ value: node["state"] });
  return {
    id,
    name,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(description !== undefined ? { description } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

/**
 * Build the production Linear seam. Every GraphQL request goes through ONE shared rate bucket + retry;
 * the transport defaults to the SDK client's `rawRequest` but is injectable for tests.
 *
 * @param token the Linear API key
 * @param request an injected GraphQL transport (defaults to the live SDK client)
 * @param bucket an injected rate bucket (defaults to one tuned under Linear's cap)
 * @returns the live Linear seam
 */
export function makeLinearApi({
  token,
  request,
  bucket,
}: {
  token: string;
  request?: LinearRequest;
  bucket?: RateBucket;
}): LinearApi {
  const client = new LinearClient({ apiKey: token });
  const send: LinearRequest =
    request ??
    (async ({ query, variables }) => {
      const res = await client.client.rawRequest(query, variables);
      return res.data;
    });
  const gate = bucket ?? new RateBucket({ ratePerSec: LINEAR_RATE_PER_SEC });
  const call: LinearRequest = async ({ query, variables }) => {
    await gate.take();
    return retry({ operation: () => send({ query, variables }) });
  };
  return {
    issues: async ({ since, cursor }) => {
      const data = await call({
        query: ISSUES_QUERY,
        variables: {
          filter: { updatedAt: { gte: since } },
          first: PAGE_SIZE,
          ...(cursor !== undefined ? { after: cursor } : {}),
        },
      });
      const connection = isRecord(data) ? data["issues"] : undefined;
      const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
      const issues: LinearIssueItem[] = [];
      for (const node of nodes) {
        const parsed = parseLinearIssueNode({ node });
        if (parsed === undefined) {
          continue;
        }
        if (parsed.commentsHasNext && parsed.commentsCursor !== undefined) {
          const more = await remainingComments({ after: parsed.commentsCursor, call, id: parsed.id });
          issues.push({ ...parsed.item, comments: [...parsed.item.comments, ...more] });
        } else {
          issues.push(parsed.item);
        }
      }
      const info = pageInfoOf({ connection });
      return { issues, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
    },
    projects: async ({ since, cursor }) => {
      const data = await call({
        query: PROJECTS_QUERY,
        variables: {
          filter: { updatedAt: { gte: since } },
          first: PAGE_SIZE,
          ...(cursor !== undefined ? { after: cursor } : {}),
        },
      });
      const connection = isRecord(data) ? data["projects"] : undefined;
      const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
      const projects = nodes
        .map((node) => parseProject({ node }))
        .filter((p): p is LinearProjectItem => p !== undefined);
      const info = pageInfoOf({ connection });
      return { projects, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
    },
  };
}
