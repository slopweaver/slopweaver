/**
 * Opportunity detection over the corpus + graph. Pure, deterministic. Three signal detectors, each
 * scored with a recency weight measured against the NEWEST record in the corpus (not wall-clock now), so
 * scores are stable across runs:
 *
 *  - cross-cutting: one reference touched by many distinct containers (a shared concern).
 *  - blocker: a referenced item that reads stale or unresolved (others are waiting on it).
 *  - duplication: the same title appearing across distinct sources (parallel work).
 */
import type { CorpusRecord, CorpusSource } from "../corpus/types.js";
import type { GraphEdge } from "./graph.js";

export interface Opportunity {
  readonly kind: "cross-cutting" | "blocker" | "duplication";
  readonly subject: string;
  readonly evidence: readonly string[];
  readonly score: number;
  readonly summary: string;
}

const STALE_AFTER_DAYS = 14;
const CROSS_CUTTING_MIN_CONTAINERS = 3;
const DAY_MS = 86_400_000;

/** The newest record time in the corpus, as ms — the reference point for recency. */
function corpusNowMs({ records }: { records: readonly CorpusRecord[] }): number {
  let max = 0;
  for (const record of records) {
    const t = Date.parse(record.tsIso);
    if (!Number.isNaN(t) && t > max) {
      max = t;
    }
  }
  return max;
}

/** Recency weight in [0,1]: 1 at `nowMs`, linearly decaying to 0 at `STALE_AFTER_DAYS` old. */
function recencyWeight({ tsIso, nowMs }: { tsIso: string; nowMs: number }): number {
  const t = Date.parse(tsIso);
  if (Number.isNaN(t)) {
    return 0;
  }
  const days = (nowMs - t) / DAY_MS;
  return Math.min(1, Math.max(0, 1 - days / STALE_AFTER_DAYS));
}

function round4({ value }: { value: number }): number {
  return Math.round(value * 10000) / 10000;
}

/** Citation-friendly reference to a record: its url, else `source:sourceId`. */
function evidenceOf({ record }: { record: CorpusRecord }): string {
  return record.url.length > 0 ? record.url : `${record.source}:${record.sourceId}`;
}

/** Normalise a title for duplicate detection: lowercase, non-alphanumerics → space, collapse whitespace. */
function normaliseTitle({ title }: { title: string }): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const UNRESOLVED_MARKERS = ["blocked", "todo", "backlog", "in progress", "open"] as const;

/** True when a record's text reads as unresolved/open work. */
function readsUnresolved({ record }: { record: CorpusRecord }): boolean {
  const haystack = [record.title, record.text]
    .filter((part) => part !== undefined)
    .join(" ")
    .toLowerCase();
  return UNRESOLVED_MARKERS.some((marker) => haystack.includes(marker));
}

function sortedUnique({ values }: { values: readonly string[] }): readonly string[] {
  return [...new Set(values)].toSorted();
}

interface CrossCutAccum {
  readonly containers: Set<string>;
  readonly evidence: Set<string>;
  recency: number;
}

function spotCrossCutting({
  records,
  nowMs,
  viaTokens,
}: {
  records: readonly CorpusRecord[];
  nowMs: number;
  viaTokens: ReadonlySet<string>;
}): readonly Opportunity[] {
  const byToken = new Map<string, CrossCutAccum>();
  for (const record of records) {
    const recency = recencyWeight({ nowMs, tsIso: record.tsIso });
    for (const token of record.refs) {
      const accum = byToken.get(token) ?? { containers: new Set<string>(), evidence: new Set<string>(), recency: 0 };
      accum.containers.add(record.container);
      accum.evidence.add(evidenceOf({ record }));
      accum.recency = Math.max(accum.recency, recency);
      byToken.set(token, accum);
    }
  }
  const opportunities: Opportunity[] = [];
  for (const [token, accum] of byToken) {
    const breadth = accum.containers.size;
    if (breadth < CROSS_CUTTING_MIN_CONTAINERS) {
      continue;
    }
    const linkBoost = viaTokens.has(token) ? 1.25 : 1;
    opportunities.push({
      evidence: sortedUnique({ values: [...accum.evidence] }),
      kind: "cross-cutting",
      score: round4({ value: breadth * (0.5 + 0.5 * accum.recency) * linkBoost }),
      subject: token,
      summary: `${token} is referenced across ${String(breadth)} distinct containers`,
    });
  }
  return opportunities;
}

function spotBlockers({ records, nowMs }: { records: readonly CorpusRecord[]; nowMs: number }): readonly Opportunity[] {
  const citeContainers = new Map<string, Set<string>>();
  for (const record of records) {
    for (const token of record.refs) {
      const containers = citeContainers.get(token) ?? new Set<string>();
      containers.add(record.container);
      citeContainers.set(token, containers);
    }
  }
  const opportunities: Opportunity[] = [];
  for (const record of records) {
    const citing = citeContainers.get(record.sourceId);
    if (citing === undefined) {
      continue;
    }
    const stale = recencyWeight({ nowMs, tsIso: record.tsIso }) <= 0;
    const unresolved = readsUnresolved({ record });
    if (!stale && !unresolved) {
      continue;
    }
    const breadth = citing.size;
    opportunities.push({
      evidence: [evidenceOf({ record })],
      kind: "blocker",
      score: round4({ value: breadth * (stale ? 1.5 : 1) }),
      subject: record.sourceId,
      summary: stale
        ? `${record.sourceId} is referenced but stale — ${String(breadth)} container(s) may be waiting`
        : `${record.sourceId} is referenced and reads unresolved across ${String(breadth)} container(s)`,
    });
  }
  return opportunities;
}

interface DupAccum {
  readonly raw: string;
  readonly sources: Set<CorpusSource>;
  readonly evidence: Set<string>;
  recency: number;
}

function spotDuplication({
  records,
  nowMs,
}: {
  records: readonly CorpusRecord[];
  nowMs: number;
}): readonly Opportunity[] {
  const byTitle = new Map<string, DupAccum>();
  for (const record of records) {
    if (record.title === undefined || record.title.length === 0) {
      continue;
    }
    const key = normaliseTitle({ title: record.title });
    if (key.length === 0) {
      continue;
    }
    const accum = byTitle.get(key) ?? {
      evidence: new Set<string>(),
      raw: record.title,
      recency: 0,
      sources: new Set<CorpusSource>(),
    };
    accum.sources.add(record.source);
    accum.evidence.add(evidenceOf({ record }));
    accum.recency = Math.max(accum.recency, recencyWeight({ nowMs, tsIso: record.tsIso }));
    byTitle.set(key, accum);
  }
  const opportunities: Opportunity[] = [];
  for (const accum of byTitle.values()) {
    if (accum.sources.size < 2) {
      continue;
    }
    opportunities.push({
      evidence: sortedUnique({ values: [...accum.evidence] }),
      kind: "duplication",
      score: round4({ value: accum.sources.size * (0.5 + 0.5 * accum.recency) }),
      subject: accum.raw,
      summary: `"${accum.raw}" appears across ${String(accum.sources.size)} distinct sources`,
    });
  }
  return opportunities;
}

/**
 * Detect cross-cutting concerns, blockers, and duplication across the corpus.
 *
 * @param records the corpus records
 * @param edges the cross-ref graph edges (a `via` token confirms a real link → boosts cross-cutting)
 * @returns opportunities sorted by score desc, then subject asc, then kind asc
 */
export function spotOpportunities({
  records,
  edges,
}: {
  records: readonly CorpusRecord[];
  edges: readonly GraphEdge[];
}): readonly Opportunity[] {
  const nowMs = corpusNowMs({ records });
  const viaTokens = new Set(edges.map((edge) => edge.via));
  const all = [
    ...spotCrossCutting({ nowMs, records, viaTokens }),
    ...spotBlockers({ nowMs, records }),
    ...spotDuplication({ nowMs, records }),
  ];
  return all.toSorted(
    (a, b) =>
      b.score - a.score ||
      (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
}
