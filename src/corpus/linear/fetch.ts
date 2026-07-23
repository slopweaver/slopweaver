/**
 * The impure Linear edge. To avoid an N+1 request explosion (the lazy `@linear/sdk` relations are one
 * GraphQL request EACH — ~7 per issue, thousands on a backfill → Linear's 2,500/hr cap), we issue ONE
 * inline GraphQL query per issue-PAGE that pulls each issue WITH its state/assignee/creator/team/project/
 * labels AND its first page of comments; only issues with more than one comment page cost an extra call.
 * So a page of N issues is ~1 request, not ~7N. Every request is paced by a shared rate scheduler
 * (well under 2,500/hr) and wrapped in {@link retryTransient} so a transient 5xx/429/network blip self-heals.
 *
 * The GraphQL transport is an INJECTED seam (`LinearRequest`) — production uses the SDK client's
 * `rawRequest`; tests inject a fake that counts requests + returns fixture data. The node parse
 * (`parseLinearIssueNode`) is pure and separately tested; `project.ts` consumes the same shaped items.
 */
import { LinearClient } from "@linear/sdk";

import { collectCursorPages } from "../../lib/paging.js";
import { isRecord } from "../../lib/parsers.js";
import { createRateScheduler, type RateScheduler, retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import { buildMemberIdentity, finaliseMemberTrust } from "../members/email.js";
import { aggregateMemberWarnings } from "../members/project.js";
import type { MemberBronzeRow } from "../members/types.js";
import type { ExportWindow } from "../types.js";
import { issueAttachmentRefs, issueEdgeRefs } from "./curated.js";
import type {
  LinearCommentItem,
  LinearDocumentItem,
  LinearInitiativeItem,
  LinearIssueItem,
  LinearProjectItem,
  LinearUpdateItem,
} from "./project.js";

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
  parent { identifier }
  children(first: 50) { nodes { identifier } }
  relations(first: 50) { nodes { type relatedIssue { identifier } } }
  attachments(first: 20) { nodes { id title url } }
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
    nodes {
      id name description url updatedAt state
      projectUpdates(first: 10) {
        nodes { id body url createdAt health user { displayName } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Initiatives (the top-level strategy artefact) — a best-effort lane; some workspaces/plans lack it. */
const INITIATIVES_QUERY = `
query Initiatives($first: Int!, $after: String) {
  initiatives(first: $first, after: $after) {
    nodes { id name description url updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Documents (deliberately-authored specs/docs) — a best-effort lane. */
const DOCUMENTS_QUERY = `
query Documents($first: Int!, $after: String) {
  documents(first: $first, after: $after) {
    nodes { id title content url updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Enumerate every org member (incl. archived — flagged inactive, not dropped) with the full profile + email. */
const USERS_QUERY = `
query Users($first: Int!, $after: String) {
  users(first: $first, after: $after, includeArchived: true) {
    nodes { id name displayName email avatarUrl active admin guest timezone teams { nodes { id key name } } }
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

/** A page of raw Linear user nodes from the seam (projected to member rows by {@link fetchLinearMembers}). */
export interface LinearUsersPage {
  readonly nodes: readonly unknown[];
  readonly nextCursor?: string;
}

/** A page of shaped initiatives from the seam. */
export interface LinearInitiativesPage {
  readonly initiatives: readonly LinearInitiativeItem[];
  readonly nextCursor?: string;
}

/** A page of shaped documents from the seam. */
export interface LinearDocumentsPage {
  readonly documents: readonly LinearDocumentItem[];
  readonly nextCursor?: string;
}

/**
 * Injected Linear seam — returns fully-resolved shaped items so `fetchLinearActivity` needs no live SDK.
 * `initiatives`/`documents` are OPTIONAL: a best-effort curated lane a workspace/plan may not expose, so
 * their absence (or failure) degrades to a warning, never a fatal error.
 */
export interface LinearApi {
  issues: (args: { since: string; cursor?: string }) => Promise<LinearIssuesPage>;
  projects: (args: { since: string; cursor?: string }) => Promise<LinearProjectsPage>;
  users: (args: { cursor?: string }) => Promise<LinearUsersPage>;
  initiatives?: (args: { cursor?: string }) => Promise<LinearInitiativesPage>;
  documents?: (args: { cursor?: string }) => Promise<LinearDocumentsPage>;
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
export async function fetchLinearActivity({ api, window }: { api: LinearApi; window: ExportWindow }): Promise<
  Result<{
    issues: readonly LinearIssueItem[];
    projects: readonly LinearProjectItem[];
    initiatives: readonly LinearInitiativeItem[];
    documents: readonly LinearDocumentItem[];
    warnings: readonly string[];
  }>
> {
  try {
    const issues = await collectCursorPages({
      fetchPage: ({ cursor }) =>
        api
          .issues({ since: window.since, ...(cursor !== undefined ? { cursor } : {}) })
          .then((page) => ({ items: page.issues, nextCursor: page.nextCursor })),
    });
    const projects = await collectCursorPages({
      fetchPage: ({ cursor }) =>
        api
          .projects({ since: window.since, ...(cursor !== undefined ? { cursor } : {}) })
          .then((page) => ({ items: page.projects, nextCursor: page.nextCursor })),
    });
    const curated = await fetchLinearCurated({ api });
    return ok({
      documents: curated.documents,
      initiatives: curated.initiatives,
      issues,
      projects,
      warnings: curated.warnings,
    });
  } catch (error: unknown) {
    return err([`fetch failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
}

/** Best-effort curated lanes (initiatives + documents): a missing/failed lane warns, never throws. */
async function fetchLinearCurated({ api }: { api: LinearApi }): Promise<{
  initiatives: readonly LinearInitiativeItem[];
  documents: readonly LinearDocumentItem[];
  warnings: readonly string[];
}> {
  const warnings: string[] = [];
  const initiatives = await bestEffortLane({
    fetch: api.initiatives,
    label: "initiatives",
    pick: (page) => ({ items: page.initiatives, nextCursor: page.nextCursor }),
    warnings,
  });
  const documents = await bestEffortLane({
    fetch: api.documents,
    label: "documents",
    pick: (page) => ({ items: page.documents, nextCursor: page.nextCursor }),
    warnings,
  });
  return { documents, initiatives, warnings };
}

/** Page one optional curated lane to exhaustion; a missing lane returns `[]`, a failing one warns + returns `[]`. */
async function bestEffortLane<TItem, TPage>({
  fetch,
  pick,
  label,
  warnings,
}: {
  fetch: ((args: { cursor?: string }) => Promise<TPage>) | undefined;
  pick: (page: TPage) => { items: readonly TItem[]; nextCursor: string | undefined };
  label: string;
  warnings: string[];
}): Promise<readonly TItem[]> {
  if (fetch === undefined) {
    return [];
  }
  try {
    return await collectCursorPages({
      fetchPage: ({ cursor }) => fetch(cursor !== undefined ? { cursor } : {}).then(pick),
    });
  } catch (error: unknown) {
    warnings.push(`linear ${label} lane unavailable: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  }
}

/** A non-empty string field, or undefined. */
function str({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The team keys off a user node's `teams` connection (skips key-less teams). Pure. */
function linearTeamKeys({ connection }: { connection: unknown }): readonly string[] {
  if (!isRecord(connection) || !Array.isArray(connection["nodes"])) {
    return [];
  }
  return connection["nodes"]
    .map((node) => (isRecord(node) ? str({ value: node["key"] }) : undefined))
    .filter((key): key is string => key !== undefined);
}

/**
 * Project one raw Linear `users` GraphQL node into a {@link MemberBronzeRow} — id + email (always present
 * for real users) + display name + timezone/avatar/teams/active/admin/guest, keeping the full raw node.
 * Pure — undefined for an id-less node.
 *
 * @param node the raw user node
 * @param fetchedAtIso the hydration timestamp
 * @returns the member row, or `undefined`
 */
export function parseLinearUserNode({
  node,
  fetchedAtIso,
}: {
  node: unknown;
  fetchedAtIso: string;
}): MemberBronzeRow | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const id = str({ value: node["id"] });
  if (id === undefined) {
    return undefined;
  }
  const displayNameVal = str({ value: node["displayName"] });
  const name = str({ value: node["name"] }) ?? displayNameVal;
  const email = str({ value: node["email"] });
  const timezone = str({ value: node["timezone"] });
  const avatarUrl = str({ value: node["avatarUrl"] });
  const teams = linearTeamKeys({ connection: node["teams"] });
  return {
    fetchedAtIso,
    identity: buildMemberIdentity({
      nativeId: id,
      source: "linear",
      ...(displayNameVal !== undefined ? { handle: displayNameVal } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    }),
    profile: {
      active: node["active"] !== false,
      bot: false,
      ...(node["admin"] === true ? { admin: true } : {}),
      ...(node["guest"] === true ? { guest: true } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(teams.length > 0 ? { teams } : {}),
    },
    provenance: ["linear.users"],
    raw: node,
    source: "linear",
    sourceId: id,
    version: 1,
    warnings: email === undefined ? ["no email on Linear user"] : [],
  };
}

/**
 * Hydrate every Linear org member (the `users` lane, paged), projecting each node + finalising trust across
 * the org. A failure is fatal (`err`) after the transport's retry budget.
 *
 * @param api the injected Linear seam
 * @param fetchedAtIso the hydration timestamp
 * @returns the member rows + warnings, or `err` on a fatal failure
 */
export async function fetchLinearMembers({
  api,
  fetchedAtIso,
}: {
  api: LinearApi;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly MemberBronzeRow[]; warnings: readonly string[] }>> {
  const rows: MemberBronzeRow[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await api.users(cursor !== undefined ? { cursor } : {});
      for (const node of page.nodes) {
        const row = parseLinearUserNode({ fetchedAtIso, node });
        if (row !== undefined) {
          rows.push(row);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return err([`linear member hydration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const finalised = finaliseMemberTrust({ rows });
  return ok({ rows: finalised, warnings: aggregateMemberWarnings({ rows: finalised }) });
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
      raw,
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

/** `str` off a nested object field (`node.state.name`, `node.team.key`), or undefined. */
function nestedStr({ value, key }: { value: unknown; key: string }): string | undefined {
  return isRecord(value) ? str({ value: value[key] }) : undefined;
}

/** The identity fields shared into the item (identifier + the fallback-title/url/ts), or undefined if no id. */
export function parseLinearIssueIdentity({
  node,
}: {
  node: Record<string, unknown>;
}): { identifier: string; title: string; url: string; tsIso: string; description?: string } | undefined {
  const identifier = str({ value: node["identifier"] });
  if (identifier === undefined) {
    return undefined;
  }
  const description = str({ value: node["description"] });
  return {
    identifier,
    title: str({ value: node["title"] }) ?? identifier,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(description !== undefined ? { description } : {}),
  };
}

/** The optional people/state/team/project relations off an issue node (missing ones drop out). Pure. */
export function parseLinearIssueRelations({ node }: { node: Record<string, unknown> }): {
  author?: string;
  assignee?: string;
  state?: string;
  team?: string;
  project?: string;
} {
  const author = displayName({ value: node["creator"] });
  const assignee = displayName({ value: node["assignee"] });
  const state = nestedStr({ key: "name", value: node["state"] });
  const team = nestedStr({ key: "key", value: node["team"] });
  const project = nestedStr({ key: "name", value: node["project"] });
  return {
    ...(author !== undefined ? { author } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(team !== undefined ? { team } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

/**
 * Parse one raw inline GraphQL issue node into a shaped item + its comment-pagination state. Pure — a
 * node from an older/partial query still parses (missing relations simply drop out). Composes the pure
 * {@link parseLinearIssueIdentity} + {@link parseLinearIssueRelations} cores.
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
  const identity = parseLinearIssueIdentity({ node });
  if (identity === undefined) {
    return undefined;
  }
  const id = str({ value: node["id"] }) ?? identity.identifier;
  const commentsPage = pageInfoOf({ connection: node["comments"] });
  const edgeRefs = issueEdgeRefs({ node });
  const attachments = issueAttachmentRefs({ node });
  const item: LinearIssueItem = {
    comments: parseComments({ nodes: isRecord(node["comments"]) ? node["comments"]["nodes"] : undefined }),
    labels: parseLabels({ connection: node["labels"] }),
    raw: node,
    ...identity,
    ...parseLinearIssueRelations({ node }),
    ...(edgeRefs.length > 0 ? { edgeRefs } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
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

/** Shape a project's `projectUpdates` connection into update items (skips body-less updates). Pure. */
export function parseProjectUpdates({ connection }: { connection: unknown }): readonly LinearUpdateItem[] {
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const updates: LinearUpdateItem[] = [];
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
    const health = str({ value: raw["health"] });
    updates.push({
      body,
      id,
      raw,
      tsIso: strOrEmpty({ value: raw["createdAt"] }),
      url: strOrEmpty({ value: raw["url"] }),
      ...(author !== undefined ? { author } : {}),
      ...(health !== undefined ? { health } : {}),
    });
  }
  return updates;
}

/** Shape one project node (with its status updates). */
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
  const updates = parseProjectUpdates({ connection: node["projectUpdates"] });
  return {
    id,
    name,
    raw: node,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(description !== undefined ? { description } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(updates.length > 0 ? { updates } : {}),
  };
}

/** Shape one initiative node (id + name required). Pure. */
export function parseInitiativeNode({ node }: { node: unknown }): LinearInitiativeItem | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const id = str({ value: node["id"] });
  const name = str({ value: node["name"] });
  if (id === undefined || name === undefined) {
    return undefined;
  }
  const description = str({ value: node["description"] });
  return {
    id,
    name,
    raw: node,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(description !== undefined ? { description } : {}),
  };
}

/** Shape one document node (id + title required). Pure. */
export function parseDocumentNode({ node }: { node: unknown }): LinearDocumentItem | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const id = str({ value: node["id"] });
  const title = str({ value: node["title"] });
  if (id === undefined || title === undefined) {
    return undefined;
  }
  const content = str({ value: node["content"] });
  return {
    id,
    raw: node,
    title,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(content !== undefined ? { content } : {}),
  };
}

/**
 * The GraphQL variables for one page of either lane — issues AND projects share the `updatedAt >= since`
 * filter + `first`/`after` cursor shape. Pure.
 *
 * @param since the `updatedAt >= ` window bound
 * @param cursor the `after` cursor (absent on the first page)
 * @returns the GraphQL variables
 */
export function pageQueryVariables({
  since,
  cursor,
}: {
  since: string;
  cursor: string | undefined;
}): Record<string, unknown> {
  return {
    filter: { updatedAt: { gte: since } },
    first: PAGE_SIZE,
    ...(cursor !== undefined ? { after: cursor } : {}),
  };
}

/** One shaped issues page: the parsed nodes (each with its comment-pagination state) + the next cursor. */
interface ShapedIssuesPage {
  readonly parsed: readonly NonNullable<ReturnType<typeof parseLinearIssueNode>>[];
  readonly nextCursor?: string;
}

/**
 * Shape one raw `issues` GraphQL response into parsed nodes + the page's next cursor. Pure — the
 * transport/comment-pagination stays in the shell; this is just projection.
 *
 * @param data the raw GraphQL `data`
 * @returns the parsed issue nodes + next cursor
 */
export function shapeIssuesPage({ data }: { data: unknown }): ShapedIssuesPage {
  const connection = isRecord(data) ? data["issues"] : undefined;
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const parsed = nodes
    .map((node) => parseLinearIssueNode({ node }))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  const info = pageInfoOf({ connection });
  return { parsed, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
}

/**
 * Shape one raw `projects` GraphQL response into shaped projects + the next cursor. Pure.
 *
 * @param data the raw GraphQL `data`
 * @returns the shaped projects + next cursor
 */
export function shapeProjectsPage({ data }: { data: unknown }): {
  projects: readonly LinearProjectItem[];
  nextCursor?: string;
} {
  const connection = isRecord(data) ? data["projects"] : undefined;
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const projects = nodes.map((node) => parseProject({ node })).filter((p): p is LinearProjectItem => p !== undefined);
  const info = pageInfoOf({ connection });
  return { projects, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
}

/** Shape one raw `initiatives` GraphQL response into shaped initiatives + the next cursor. Pure. */
export function shapeInitiativesPage({ data }: { data: unknown }): LinearInitiativesPage {
  const connection = isRecord(data) ? data["initiatives"] : undefined;
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const initiatives = nodes
    .map((node) => parseInitiativeNode({ node }))
    .filter((p): p is LinearInitiativeItem => p !== undefined);
  const info = pageInfoOf({ connection });
  return { initiatives, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
}

/** Shape one raw `documents` GraphQL response into shaped documents + the next cursor. Pure. */
export function shapeDocumentsPage({ data }: { data: unknown }): LinearDocumentsPage {
  const connection = isRecord(data) ? data["documents"] : undefined;
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const documents = nodes
    .map((node) => parseDocumentNode({ node }))
    .filter((p): p is LinearDocumentItem => p !== undefined);
  const info = pageInfoOf({ connection });
  return { documents, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
}

/**
 * Build the production Linear seam. Every GraphQL request goes through ONE shared rate scheduler +
 * transient retry; the transport defaults to the SDK client's `rawRequest` but is injectable for tests.
 *
 * @param token the Linear API key
 * @param request an injected GraphQL transport (defaults to the live SDK client)
 * @param scheduler an injected rate scheduler (defaults to one tuned under Linear's cap)
 * @returns the live Linear seam
 */
export function makeLinearApi({
  token,
  request,
  scheduler,
}: {
  token: string;
  request?: LinearRequest;
  scheduler?: RateScheduler;
}): LinearApi {
  const client = new LinearClient({ apiKey: token });
  // The one raw SDK boundary: routed through safeApiCall (typed error) and re-surfaced by orThrow so the
  // retry/gate loop below and fetchLinearActivity's fatal policy run unchanged.
  const send: LinearRequest =
    request ??
    (async ({ query, variables }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () => client.client.rawRequest(query, variables),
          operation: "linear.rawRequest",
          provider: "linear",
        }),
      });
      return res.data;
    });
  const gate = scheduler ?? createRateScheduler({ ratePerSec: LINEAR_RATE_PER_SEC });
  // Retry is OUTSIDE the gate so every attempt (including a post-429 retry) re-acquires a rate slot and
  // stays paced — gating only the first try would let retries burst straight past the rate ceiling.
  const call: LinearRequest = ({ query, variables }) =>
    retryTransient({ operation: () => gate(() => send({ query, variables })) });
  return {
    documents: cursorLane({ call, query: DOCUMENTS_QUERY, shape: shapeDocumentsPage }),
    initiatives: cursorLane({ call, query: INITIATIVES_QUERY, shape: shapeInitiativesPage }),
    issues: issuesLane({ call }),
    projects: async ({ since, cursor }) =>
      shapeProjectsPage({
        data: await call({ query: PROJECTS_QUERY, variables: pageQueryVariables({ cursor, since }) }),
      }),
    users: cursorLane({ call, query: USERS_QUERY, shape: shapeUsersPage }),
  };
}

/** A cursor-only paged lane: run `query` with `{first, after?}`, shape the result. */
function cursorLane<T>({
  call,
  query,
  shape,
}: {
  call: LinearRequest;
  query: string;
  shape: (args: { data: unknown }) => T;
}): (args: { cursor?: string }) => Promise<T> {
  return async ({ cursor }) => {
    const data = await call({
      query,
      variables: { first: PAGE_SIZE, ...(cursor !== undefined ? { after: cursor } : {}) },
    });
    return shape({ data });
  };
}

/** The issues lane: one inline query per page + a follow-up only for issues whose comments overflow a page. */
function issuesLane({ call }: { call: LinearRequest }): LinearApi["issues"] {
  return async ({ since, cursor }) => {
    const data = await call({ query: ISSUES_QUERY, variables: pageQueryVariables({ cursor, since }) });
    const shaped = shapeIssuesPage({ data });
    const issues: LinearIssueItem[] = [];
    for (const parsed of shaped.parsed) {
      if (parsed.commentsHasNext && parsed.commentsCursor !== undefined) {
        const more = await remainingComments({ after: parsed.commentsCursor, call, id: parsed.id });
        issues.push({ ...parsed.item, comments: [...parsed.item.comments, ...more] });
      } else {
        issues.push(parsed.item);
      }
    }
    return { issues, ...(shaped.nextCursor !== undefined ? { nextCursor: shaped.nextCursor } : {}) };
  };
}

/**
 * Shape one raw `users` GraphQL response into raw user nodes + the next cursor. Pure — projection to member
 * rows stays in {@link fetchLinearMembers} so the transport is testable apart from the node parse.
 *
 * @param data the raw GraphQL `data`
 * @returns the raw user nodes + next cursor
 */
export function shapeUsersPage({ data }: { data: unknown }): LinearUsersPage {
  const connection = isRecord(data) ? data["users"] : undefined;
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const info = pageInfoOf({ connection });
  return { nodes, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
}
