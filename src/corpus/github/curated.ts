/**
 * The GitHub curated-knowledge lane (PR4.3): the deliberately-authored planning + ownership artefacts —
 * **discussions** (GraphQL), **releases** + **milestones** (REST), and **CODEOWNERS** (repo content) —
 * projected into `CorpusRecord`s, with milestone→issue grouping edges and CODEOWNERS→owner ownership
 * edges. Every sub-lane is BEST-EFFORT: discussions may be disabled, a repo may have no CODEOWNERS, so a
 * failure warns + skips rather than sinking the pass. Projects v2 is noted as a follow-on (heavy GraphQL,
 * frequently empty) and deliberately not built here — see the PR notes.
 *
 * The GraphQL/REST boundary is an INJECTED seam ({@link GithubCuratedApi}); production wires it to the
 * resilient octokit client (retry + throttle plugins) via {@link makeGithubCuratedApi}. The shapers +
 * projectors are pure and unit-tested with fixtures.
 */
import type { Repository } from "../../config.js";
import { errorStatus, ingestErrorToThrowable } from "../../lib/ingestError.js";
import { isRecord } from "../../lib/parsers.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import { classifyCurated } from "../curated/classify.js";
import { CURATED_CLASS_ATTR, CURATED_EDGES_ATTR, encodeCuratedEdgeRef } from "../curated/types.js";
import { extractRefs } from "../refs.js";
import type { CorpusAttributeValue, CorpusRecord } from "../types.js";
import { type GithubClient, makeGithubClient } from "./fetch.js";

const PER_PAGE = 100;
const DISCUSSIONS_PER_PAGE = 50;

/** A GitHub discussion (deliberately-authored Q&A / RFC / decision). */
export interface GithubDiscussionItem {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tsIso: string;
  readonly author?: string;
  readonly category?: string;
}

/** A GitHub release (a shipped-status artefact). */
export interface GithubReleaseItem {
  readonly tag: string;
  readonly name: string;
  readonly body: string;
  readonly url: string;
  readonly tsIso: string;
  readonly author?: string;
}

/** A GitHub milestone + the issue/PR numbers grouped under it (the grouping edge targets). */
export interface GithubMilestoneItem {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly tsIso: string;
  readonly state?: string;
  readonly issueNumbers: readonly number[];
}

/** The parsed CODEOWNERS file: the raw rules text + the distinct owners it names. */
export interface GithubCodeownersItem {
  readonly path: string;
  readonly text: string;
  readonly owners: readonly string[];
}

/** The curated GitHub surfaces gathered for one repo. */
export interface GithubCuratedItems {
  readonly discussions: readonly GithubDiscussionItem[];
  readonly releases: readonly GithubReleaseItem[];
  readonly milestones: readonly GithubMilestoneItem[];
  readonly codeowners?: GithubCodeownersItem;
}

/** A non-empty string field off an unknown, or undefined. Pure. */
function str({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A string field off an unknown, or "" when absent (an honest empty sentinel, not a fail-loud path). Pure. */
function strOrEmpty({ value }: { value: unknown }): string {
  return typeof value === "string" ? value : "";
}

/** The `.login` off a nested author object. Pure. */
function login({ value }: { value: unknown }): string | undefined {
  return isRecord(value) ? str({ value: value["login"] }) : undefined;
}

/** Shape one raw GraphQL discussion node, or undefined when number-less. Pure. */
export function parseDiscussionNode({ node }: { node: unknown }): GithubDiscussionItem | undefined {
  if (!isRecord(node) || typeof node["number"] !== "number") {
    return undefined;
  }
  const category = isRecord(node["category"]) ? str({ value: node["category"]["name"] }) : undefined;
  const author = login({ value: node["author"] });
  return {
    body: strOrEmpty({ value: node["body"] }),
    number: node["number"],
    title: str({ value: node["title"] }) ?? `Discussion #${String(node["number"])}`,
    tsIso: strOrEmpty({ value: node["updatedAt"] }),
    url: strOrEmpty({ value: node["url"] }),
    ...(author !== undefined ? { author } : {}),
    ...(category !== undefined ? { category } : {}),
  };
}

/** Shape one raw REST release, or undefined when tag-less. Pure. */
export function parseReleaseNode({ raw }: { raw: unknown }): GithubReleaseItem | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const tag = str({ value: raw["tag_name"] });
  if (tag === undefined) {
    return undefined;
  }
  const author = login({ value: raw["author"] });
  return {
    body: strOrEmpty({ value: raw["body"] }),
    name: str({ value: raw["name"] }) ?? tag,
    tag,
    tsIso: str({ value: raw["published_at"] }) ?? strOrEmpty({ value: raw["created_at"] }),
    url: strOrEmpty({ value: raw["html_url"] }),
    ...(author !== undefined ? { author } : {}),
  };
}

/** Shape one raw REST milestone (without its issues — the shell attaches those), or undefined. Pure. */
export function parseMilestoneNode({ raw }: { raw: unknown }): Omit<GithubMilestoneItem, "issueNumbers"> | undefined {
  if (!isRecord(raw) || typeof raw["number"] !== "number") {
    return undefined;
  }
  const state = str({ value: raw["state"] });
  return {
    description: strOrEmpty({ value: raw["description"] }),
    number: raw["number"],
    title: str({ value: raw["title"] }) ?? `Milestone ${String(raw["number"])}`,
    tsIso: str({ value: raw["updated_at"] }) ?? strOrEmpty({ value: raw["created_at"] }),
    url: strOrEmpty({ value: raw["html_url"] }),
    ...(state !== undefined ? { state } : {}),
  };
}

/** The `number`s of a raw issue list (the issues grouped under a milestone). Pure. */
export function issueNumbersOf({ raw }: { raw: readonly unknown[] }): readonly number[] {
  return raw
    .map((issue) => (isRecord(issue) && typeof issue["number"] === "number" ? issue["number"] : undefined))
    .filter((n): n is number => n !== undefined);
}

/** One CODEOWNERS owner token → its `github:<team|user>:<id>` node key (an `@`-prefixed handle). Pure. */
function ownerNode({ owner }: { owner: string }): string | undefined {
  if (!owner.startsWith("@") || owner.length < 2) {
    return undefined;
  }
  const handle = owner.slice(1);
  return handle.includes("/") ? `github:team:${handle}` : `github:user:${handle}`;
}

/** Parse CODEOWNERS text into `{text, owners}` — the distinct `@`-owners across every rule. Pure. */
export function parseCodeowners({ content, path }: { content: string; path: string }): GithubCodeownersItem {
  const owners = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    for (const token of trimmed.split(/\s+/).slice(1)) {
      if (token.startsWith("@")) {
        owners.add(token);
      }
    }
  }
  return { owners: [...owners], path, text: content };
}

/** Attach a classification attr when the heuristic fires. Pure. */
function classifiedAttrs({
  attrs,
  kind,
  title,
  text,
}: {
  attrs: Record<string, CorpusAttributeValue>;
  kind: CorpusRecord["kind"];
  title: string;
  text: string;
}): Record<string, CorpusAttributeValue> {
  const classification = classifyCurated({ kind, text, title });
  return classification !== undefined ? { ...attrs, [CURATED_CLASS_ATTR]: classification } : attrs;
}

/** One `discussion` record. Pure. */
function discussionRecord({ discussion, repo }: { discussion: GithubDiscussionItem; repo: string }): CorpusRecord {
  const text = discussion.body.length > 0 ? discussion.body : discussion.title;
  return {
    attrs: classifiedAttrs({ attrs: {}, kind: "discussion", text, title: discussion.title }),
    container: repo,
    kind: "discussion",
    refs: extractRefs({ text: `${discussion.title}\n${discussion.body}` }),
    source: "github",
    sourceId: `discussion:#${String(discussion.number)}`,
    text,
    title: discussion.title,
    tsIso: discussion.tsIso,
    url: discussion.url,
    ...(discussion.author !== undefined ? { author: discussion.author } : {}),
  };
}

/** One `release` record (classified `status`). Pure. */
function releaseRecord({ release, repo }: { release: GithubReleaseItem; repo: string }): CorpusRecord {
  const text = release.body.length > 0 ? release.body : release.name;
  return {
    attrs: classifiedAttrs({ attrs: {}, kind: "release", text, title: release.name }),
    container: repo,
    kind: "release",
    refs: extractRefs({ text: `${release.name}\n${release.body}` }),
    source: "github",
    sourceId: `release:${release.tag}`,
    text,
    title: release.name,
    tsIso: release.tsIso,
    url: release.url,
    ...(release.author !== undefined ? { author: release.author } : {}),
  };
}

/** One `milestone` record, with a grouping edge to each grouped issue/PR. Pure. */
function milestoneRecord({ milestone, repo }: { milestone: GithubMilestoneItem; repo: string }): CorpusRecord {
  const edges = milestone.issueNumbers.map((n) =>
    encodeCuratedEdgeRef({ kind: "milestone", target: `github:#${String(n)}` }),
  );
  const base: Record<string, CorpusAttributeValue> = edges.length > 0 ? { [CURATED_EDGES_ATTR]: edges } : {};
  const text = milestone.description.length > 0 ? milestone.description : milestone.title;
  return {
    attrs: classifiedAttrs({ attrs: base, kind: "milestone", text, title: milestone.title }),
    container: repo,
    kind: "milestone",
    refs: extractRefs({ text: `${milestone.title}\n${milestone.description}` }),
    source: "github",
    sourceId: `milestone:${String(milestone.number)}`,
    text,
    title: milestone.title,
    tsIso: milestone.tsIso,
    url: milestone.url,
  };
}

/** One `codeowners` record (classified `ownership`), with an `owns` edge to each named team/user. Pure. */
function codeownersRecord({ codeowners, repo }: { codeowners: GithubCodeownersItem; repo: string }): CorpusRecord {
  const edges = codeowners.owners
    .map((owner) => ownerNode({ owner }))
    .filter((node): node is string => node !== undefined)
    .map((target) => encodeCuratedEdgeRef({ kind: "owns", target }));
  const base: Record<string, CorpusAttributeValue> = edges.length > 0 ? { [CURATED_EDGES_ATTR]: edges } : {};
  return {
    attrs: { ...base, [CURATED_CLASS_ATTR]: "ownership" },
    container: repo,
    kind: "codeowners",
    refs: [],
    source: "github",
    sourceId: `codeowners:${codeowners.path}`,
    text: codeowners.text,
    title: `CODEOWNERS (${codeowners.path})`,
    tsIso: "",
    url: `https://github.com/${repo}/blob/HEAD/${codeowners.path}`,
  };
}

/**
 * Project the curated GitHub surfaces into corpus records (+ their grouping/ownership edges).
 *
 * @param items the gathered curated surfaces
 * @param repo the `owner/repo` container string
 * @returns the flattened corpus records
 */
export function projectGithubCurated({
  items,
  repo,
}: {
  items: GithubCuratedItems;
  repo: string;
}): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const discussion of items.discussions) {
    records.push(discussionRecord({ discussion, repo }));
  }
  for (const release of items.releases) {
    records.push(releaseRecord({ release, repo }));
  }
  for (const milestone of items.milestones) {
    records.push(milestoneRecord({ milestone, repo }));
  }
  if (items.codeowners !== undefined && items.codeowners.text.trim().length > 0) {
    records.push(codeownersRecord({ codeowners: items.codeowners, repo }));
  }
  return records;
}

/** The raw content + path of a discovered CODEOWNERS file. */
export interface GithubCodeownersRaw {
  readonly content: string;
  readonly path: string;
}

/**
 * The injected GitHub curated seam. Each method returns raw payloads (the shell shapes them); production
 * wires them to the resilient octokit client. Kept small so each can be safe-wrapped in isolation.
 */
export interface GithubCuratedApi {
  discussions: (args: { repo: Repository }) => Promise<readonly unknown[]>;
  releases: (args: { repo: Repository }) => Promise<readonly unknown[]>;
  milestones: (args: { repo: Repository }) => Promise<readonly unknown[]>;
  milestoneIssues: (args: { repo: Repository; milestone: number }) => Promise<readonly unknown[]>;
  codeowners: (args: { repo: Repository }) => Promise<GithubCodeownersRaw | undefined>;
}

/** Run one best-effort lane: on failure, push a warning + return the fallback (never throws). */
async function bestEffort<T>({
  run,
  label,
  warnings,
  fallback,
}: {
  run: () => Promise<T>;
  label: string;
  warnings: string[];
  fallback: T;
}): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    warnings.push(`github ${label} skipped: ${error instanceof Error ? error.message : "unknown"}`);
    return fallback;
  }
}

/** Fetch milestone items, attaching each milestone's grouped issue/PR numbers (best-effort per milestone). */
async function fetchMilestones({
  api,
  repo,
  warnings,
}: {
  api: GithubCuratedApi;
  repo: Repository;
  warnings: string[];
}): Promise<readonly GithubMilestoneItem[]> {
  const raw = await bestEffort({
    fallback: [] as readonly unknown[],
    label: "milestones",
    run: () => api.milestones({ repo }),
    warnings,
  });
  const milestones: GithubMilestoneItem[] = [];
  for (const node of raw) {
    const base = parseMilestoneNode({ raw: node });
    if (base === undefined) {
      continue;
    }
    const issues = await bestEffort({
      fallback: [] as readonly unknown[],
      label: `milestone ${String(base.number)} issues`,
      run: () => api.milestoneIssues({ milestone: base.number, repo }),
      warnings,
    });
    milestones.push({ ...base, issueNumbers: issueNumbersOf({ raw: issues }) });
  }
  return milestones;
}

/**
 * Gather every curated GitHub surface for one repo, best-effort (a disabled/absent lane warns + skips).
 *
 * @param api the injected curated seam
 * @param repo the repository coordinate
 * @returns the gathered curated surfaces + any per-lane warnings
 */
export async function fetchGithubCurated({
  api,
  repo,
}: {
  api: GithubCuratedApi;
  repo: Repository;
}): Promise<{ items: GithubCuratedItems; warnings: readonly string[] }> {
  const warnings: string[] = [];
  const discussionsRaw = await bestEffort({
    fallback: [] as readonly unknown[],
    label: "discussions",
    run: () => api.discussions({ repo }),
    warnings,
  });
  const releasesRaw = await bestEffort({
    fallback: [] as readonly unknown[],
    label: "releases",
    run: () => api.releases({ repo }),
    warnings,
  });
  const milestones = await fetchMilestones({ api, repo, warnings });
  const codeownersRaw = await bestEffort({
    fallback: undefined,
    label: "codeowners",
    run: () => api.codeowners({ repo }),
    warnings,
  });
  const items: GithubCuratedItems = {
    discussions: discussionsRaw
      .map((node) => parseDiscussionNode({ node }))
      .filter((d): d is GithubDiscussionItem => d !== undefined),
    milestones,
    releases: releasesRaw
      .map((raw) => parseReleaseNode({ raw }))
      .filter((r): r is GithubReleaseItem => r !== undefined),
    ...(codeownersRaw !== undefined
      ? { codeowners: parseCodeowners({ content: codeownersRaw.content, path: codeownersRaw.path }) }
      : {}),
  };
  return { items, warnings };
}

const DISCUSSIONS_QUERY = `
query Discussions($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    discussions(first: ${String(DISCUSSIONS_PER_PAGE)}, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title body url updatedAt author { login } category { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** The candidate CODEOWNERS locations, in GitHub's documented precedence. */
const CODEOWNERS_PATHS: readonly string[] = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** Fetch every discussion node via GraphQL, paged to exhaustion (safe-wrapped). */
async function discussionsLive({
  client,
  repo,
}: {
  client: GithubClient;
  repo: Repository;
}): Promise<readonly unknown[]> {
  const nodes: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    const data = orThrow({
      result: await safeApiCall({
        execute: () => client.graphql(DISCUSSIONS_QUERY, { after, owner: repo.owner, repo: repo.repo }),
        operation: "github.graphql.discussions",
        provider: "github",
      }),
    });
    const connection = isRecord(data) && isRecord(data["repository"]) ? data["repository"]["discussions"] : undefined;
    const page = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
    nodes.push(...page);
    const next = connectionNextCursor({ connection });
    if (next === undefined) {
      return nodes;
    }
    after = next;
  }
}

/** The `endCursor` of a GraphQL connection when it has a next page, else undefined. Pure. */
function connectionNextCursor({ connection }: { connection: unknown }): string | undefined {
  const info = isRecord(connection) && isRecord(connection["pageInfo"]) ? connection["pageInfo"] : undefined;
  const endCursor = info?.["endCursor"];
  return info?.["hasNextPage"] === true && typeof endCursor === "string" ? endCursor : undefined;
}

/**
 * Fetch the repo's CODEOWNERS from its first present location, or undefined when genuinely absent. A 404
 * for a path means "not here" — try the next; ANY OTHER error (403 permissions, 5xx, network) is thrown so
 * the caller's best-effort wrapper turns it into a warning rather than silently conflating failure with
 * absence.
 */
async function codeownersLive({
  client,
  repo,
}: {
  client: GithubClient;
  repo: Repository;
}): Promise<GithubCodeownersRaw | undefined> {
  for (const path of CODEOWNERS_PATHS) {
    const res = await safeApiCall({
      execute: () => client.rest.repos.getContent({ owner: repo.owner, path, repo: repo.repo }),
      operation: "github.repos.getContent",
      provider: "github",
    });
    if (res.isErr()) {
      if (errorStatus({ error: res.error }) === 404) {
        continue; // this path has no CODEOWNERS — try the next documented location
      }
      throw ingestErrorToThrowable({ error: res.error }); // a real failure — surfaced as a warning upstream
    }
    const data: unknown = res.value.data;
    if (isRecord(data) && data["encoding"] === "base64" && typeof data["content"] === "string") {
      return { content: Buffer.from(data["content"], "base64").toString("utf8"), path };
    }
  }
  return undefined;
}

/**
 * Build the production GitHub curated seam over a resilient octokit client. Discussions via GraphQL;
 * releases/milestones/milestone-issues via REST pagination; CODEOWNERS via repo content. Every SDK call is
 * routed through a `safe*` wrapper.
 *
 * @param token the GitHub token
 * @returns the live curated seam
 */
export function makeGithubCuratedApi({ token }: { token: string | undefined }): GithubCuratedApi {
  const client = makeGithubClient({ token });
  return {
    codeowners: ({ repo }) => codeownersLive({ client, repo }),
    discussions: ({ repo }) => discussionsLive({ client, repo }),
    milestoneIssues: async ({ repo, milestone }) =>
      orThrow({
        result: await safeApiCall({
          execute: () =>
            client.rest.issues.listForRepo({
              milestone: String(milestone),
              owner: repo.owner,
              per_page: PER_PAGE,
              repo: repo.repo,
              state: "all",
            }),
          operation: "github.issues.listForRepo",
          provider: "github",
        }),
      }).data,
    milestones: async ({ repo }) =>
      orThrow({
        result: await safeApiCall({
          execute: () =>
            client.rest.issues.listMilestones({ owner: repo.owner, per_page: PER_PAGE, repo: repo.repo, state: "all" }),
          operation: "github.issues.listMilestones",
          provider: "github",
        }),
      }).data,
    releases: async ({ repo }) =>
      orThrow({
        result: await safeApiCall({
          execute: () => client.rest.repos.listReleases({ owner: repo.owner, per_page: PER_PAGE, repo: repo.repo }),
          operation: "github.repos.listReleases",
          provider: "github",
        }),
      }).data,
  };
}
