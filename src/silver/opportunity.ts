/**
 * Opportunity detection over the corpus + graph. Pure, deterministic. Three signal detectors, each
 * scored with a recency weight measured against the NEWEST record in the corpus (not wall-clock now), so
 * scores are stable across runs:
 *
 *  - cross-cutting: one reference touched by many distinct containers (a shared concern).
 *  - blocker: a referenced item that reads stale or unresolved (others are waiting on it).
 *  - duplication: the same title appearing across distinct sources (parallel work).
 *
 * The blocker detector is split into pure cores ({@link blockerCitationInfo} + {@link blockerOpportunityForRecord})
 * so the "stale only when a recent record still cites it" decision is unit-tested in isolation.
 */

import type { CorpusRecord, CorpusSource } from "../corpus/types.js";
import { sortedUnique } from "../lib/collections.js";
import { compareStrings } from "../lib/compare.js";
import { parseIsoMs } from "../lib/date.js";
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
    const t = parseIsoMs({ tsIso: record.tsIso });
    if (t !== undefined && t > max) {
      max = t;
    }
  }
  return max;
}

/** Recency weight in [0,1]: 1 at `nowMs`, linearly decaying to 0 at `STALE_AFTER_DAYS` old. */
function recencyWeight({ tsIso, nowMs }: { tsIso: string; nowMs: number }): number {
  const t = parseIsoMs({ tsIso });
  if (t === undefined) {
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

interface CiteInfo {
  readonly containers: Set<string>;
  /** The newest citing record's time (ms) — a recent citer means someone is CURRENTLY waiting. */
  latestCiterMs: number;
}

/**
 * Index, per referenced token, which containers cite it and the newest citer's time. Pure.
 *
 * @param records the corpus records
 * @returns the citation info by cited token
 */
export function blockerCitationInfo({ records }: { records: readonly CorpusRecord[] }): Map<string, CiteInfo> {
  const citeInfo = new Map<string, CiteInfo>();
  for (const record of records) {
    const citerMs = parseIsoMs({ tsIso: record.tsIso });
    for (const token of record.refs) {
      const info = citeInfo.get(token) ?? { containers: new Set<string>(), latestCiterMs: 0 };
      info.containers.add(record.container);
      if (citerMs !== undefined) {
        info.latestCiterMs = Math.max(info.latestCiterMs, citerMs);
      }
      citeInfo.set(token, info);
    }
  }
  return citeInfo;
}

/**
 * The blocker opportunity for one target record, or `undefined` when it isn't a blocker. A record is a
 * blocker when it is cited AND (it is stale WITH a recent citer, OR it reads unresolved). Staleness alone
 * (a valid old record that merely predates the window) is NOT a blocker. Pure.
 *
 * @param record the potential target
 * @param citing the citation info for this record's `sourceId` (undefined ⇒ never cited)
 * @param nowMs the corpus-newest reference time
 * @returns the blocker opportunity, or undefined
 */
export function blockerOpportunityForRecord({
  record,
  citing,
  nowMs,
}: {
  record: CorpusRecord;
  citing: CiteInfo | undefined;
  nowMs: number;
}): Opportunity | undefined {
  if (citing === undefined) {
    return undefined;
  }
  const targetStale = recencyWeight({ nowMs, tsIso: record.tsIso }) <= 0;
  const citerRecent = citing.latestCiterMs > 0 && (nowMs - citing.latestCiterMs) / DAY_MS < STALE_AFTER_DAYS;
  const stale = targetStale && citerRecent;
  const unresolved = readsUnresolved({ record });
  if (!stale && !unresolved) {
    return undefined;
  }
  const breadth = citing.containers.size;
  return {
    evidence: [evidenceOf({ record })],
    kind: "blocker",
    score: round4({ value: breadth * (stale ? 1.5 : 1) }),
    subject: record.sourceId,
    summary: stale
      ? `${record.sourceId} is referenced but stale — ${String(breadth)} container(s) may be waiting`
      : `${record.sourceId} is referenced and reads unresolved across ${String(breadth)} container(s)`,
  };
}

function spotBlockers({ records, nowMs }: { records: readonly CorpusRecord[]; nowMs: number }): readonly Opportunity[] {
  const citeInfo = blockerCitationInfo({ records });
  return records
    .map((record) => blockerOpportunityForRecord({ citing: citeInfo.get(record.sourceId), nowMs, record }))
    .filter((opportunity): opportunity is Opportunity => opportunity !== undefined);
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

/** Opportunity ordering: score desc, then subject asc, then kind asc. Pure. */
export function sortOpportunities({
  opportunities,
}: {
  opportunities: readonly Opportunity[];
}): readonly Opportunity[] {
  return opportunities.toSorted(
    (a, b) =>
      b.score - a.score || compareStrings({ a: a.subject, b: b.subject }) || compareStrings({ a: a.kind, b: b.kind }),
  );
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
  return sortOpportunities({ opportunities: all });
}
