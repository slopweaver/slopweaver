/**
 * The cross-ref graph: undirected edges between records that share a reference token — the same issue
 * key, PR number, meaningful URL, or @mention. Pure, deterministic. Each shared token forms a clique
 * over the records that hold it; the edge's `via` records which token linked them.
 *
 * PR3.5 stopgap caps (a real graph lands in PR10, which deletes this heuristic):
 *  - **Entity-token filter** ({@link isGraphEntityToken}): only entity-shaped tokens (ticket keys,
 *    issue/PR ids, real mention handles, URLs with a meaningful path) enter the index. JSDoc tags /
 *    npm scopes (`@param`, `@octokit`) and bare root/boilerplate URLs were the bulk of the 873k-edge
 *    blow-up — they are dropped before they can form a clique.
 *  - **Hard clique cap**: a token is skipped if its clique would exceed `MAX_EDGES_PER_TOKEN` edges (or
 *    `MAX_HOLDERS_PER_TOKEN` holders) — bounding the O(H²) worst case so one hub token can't explode the
 *    graph. Real shared entities never fan out that far.
 */
import { extractRefs } from "../corpus/refs.js";
import type { CorpusRecord } from "../corpus/types.js";

/** Max records one token may link before it's treated as a hub and skipped. */
export const MAX_HOLDERS_PER_TOKEN = 50;
/** Hard ceiling on the clique a single token may form — the primary guard on total graph size. */
export const MAX_EDGES_PER_TOKEN = 500;

/** Hosts whose URLs are boilerplate (licenses, schemas), never a real cross-reference. */
const BOILERPLATE_URL_HOSTS: ReadonlySet<string> = new Set([
  "schema.org",
  "w3.org",
  "www.w3.org",
  "opensource.org",
  "spdx.org",
  "gnu.org",
  "www.gnu.org",
  "apache.org",
  "www.apache.org",
  "creativecommons.org",
]);

/** `@`-tokens that are code/docs, not people — JSDoc tags and the npm scopes seen in ingested snippets. */
const NON_ENTITY_AT_TOKENS: ReadonlySet<string> = new Set([
  "param",
  "returns",
  "return",
  "throws",
  "throw",
  "example",
  "link",
  "links",
  "see",
  "default",
  "deprecated",
  "since",
  "type",
  "types",
  "todo",
  "fixme",
  "note",
  "override",
  "packagemanager",
  "babel",
  "octokit",
  "slack",
  "linear",
  "notionhq",
  "xenova",
  "eslint",
  "biome",
  "ts",
  "tsx",
]);

export interface GraphEdge {
  readonly a: string;
  readonly b: string;
  readonly via: string;
}

/** Whether a URL has a path worth linking on (drops a bare host / root / boilerplate URL). */
function hasMeaningfulUrlPath({ url }: { url: string }): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (BOILERPLATE_URL_HOSTS.has(parsed.hostname)) {
    return false;
  }
  return parsed.pathname.replace(/\/+$/, "").length > 1; // more than just "/"
}

/**
 * Whether a token is a real cross-reference ENTITY (vs graph noise). Keeps ticket keys (`TEAM-123`),
 * issue/PR ids (`#123`), real mention handles, and URLs with a meaningful path; drops JSDoc tags, npm
 * scopes, and bare/boilerplate URLs. Pure — a stopgap heuristic, replaced by PR10.
 *
 * @param token a candidate link token
 * @returns true when the token should participate in the cross-ref graph
 */
export function isGraphEntityToken({ token }: { token: string }): boolean {
  if (token.length === 0) {
    return false;
  }
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(token) || /^#\d+$/.test(token)) {
    return true;
  }
  if (token.startsWith("@")) {
    const handle = token.slice(1).toLowerCase();
    return handle.length > 0 && !NON_ENTITY_AT_TOKENS.has(handle);
  }
  if (/^https?:\/\//.test(token)) {
    return hasMeaningfulUrlPath({ url: token });
  }
  return false;
}

/** Stable node key for a record. */
function nodeKey({ record }: { record: CorpusRecord }): string {
  return `${record.source}:${record.sourceId}`;
}

/** The link tokens a record contributes: its refs plus tokens mined from its url/title/sourceId, filtered
 * to entity-shaped tokens only (see {@link isGraphEntityToken}). */
function linkTokens({ record }: { record: CorpusRecord }): readonly string[] {
  const identityText = [record.url, record.title, record.sourceId]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" ");
  const identity = [record.url, ...extractRefs({ text: identityText })];
  return [...record.refs, ...identity].filter((token) => token.length > 0 && isGraphEntityToken({ token }));
}

/**
 * Build the cross-ref graph over the corpus.
 *
 * @param records the corpus records
 * @returns sorted `nodes` (node keys) and undirected `edges` (`a < b`, with the linking `via` token)
 */
export function buildCrossRefGraph({ records }: { records: readonly CorpusRecord[] }): {
  nodes: readonly string[];
  edges: readonly GraphEdge[];
} {
  const nodes = new Set<string>();
  const tokenIndex = new Map<string, Set<string>>();
  for (const record of records) {
    const key = nodeKey({ record });
    nodes.add(key);
    for (const token of linkTokens({ record })) {
      const holders = tokenIndex.get(token) ?? new Set<string>();
      holders.add(key);
      tokenIndex.set(token, holders);
    }
  }

  const edges = new Map<string, GraphEdge>();
  for (const [token, holderSet] of tokenIndex) {
    const potentialEdges = (holderSet.size * (holderSet.size - 1)) / 2;
    if (holderSet.size < 2 || holderSet.size > MAX_HOLDERS_PER_TOKEN || potentialEdges > MAX_EDGES_PER_TOKEN) {
      continue; // too small to link, or a hub whose O(H²) clique would blow up the graph
    }
    const holders = [...holderSet];
    for (let i = 0; i < holders.length; i += 1) {
      for (let j = i + 1; j < holders.length; j += 1) {
        const first = holders[i]!; // i, j index within `holders` bounds
        const second = holders[j]!;
        const [a, b] = first < second ? [first, second] : [second, first];
        const edgeKey = `${a} ${b}`;
        const existing = edges.get(edgeKey);
        if (existing === undefined || token < existing.via) {
          edges.set(edgeKey, { a, b, via: token });
        }
      }
    }
  }

  return {
    edges: [...edges.values()].toSorted((x, y) =>
      x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0,
    ),
    nodes: [...nodes].toSorted(),
  };
}
