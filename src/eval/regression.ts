/**
 * The deterministic eval-REGRESSION check that gates every PR. It scores retrieval recall@k over a
 * FROZEN corpus fixture with FROZEN queries at a PINNED reference time, so it is byte-reproducible on any
 * machine and in CI — no Claude, no embedding model, no live GitHub, no wall-clock. It then compares that
 * candidate recall against a frozen baseline's floors (overall + per-cluster) and fails on any drop.
 *
 * Why deterministic BM25 (not the semantic path users get): the on-device embedder needs a one-time model
 * download and would make CI non-hermetic. So the gate measures the DETERMINISTIC lexical+recency-decay
 * retrieval floor — the layer a code change can silently regress — while the semantic scoreboard
 * (docs/eval-baseline.md) stays the advisory, human-run companion. Recall here reuses the SAME frozen
 * `scoreGrounding` the scoreboard uses, so "recall@k" means exactly one thing across the harness.
 *
 * Honest by construction: no smoothing. Equal-to-baseline passes; anything below a floor fails. The
 * baseline moves ONLY through the explicit `rebaseline` command — never from this check.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import type { CorpusRecord } from "../corpus/types.js";
import { decayParamsFromDays } from "../retrieval/recencyDecay.js";
import { buildRetrievalIndex, search } from "../retrieval/retrievalIndex.js";
import { GOLDEN_CASES, type GoldenCase, type QuestionClass, scoreGrounding } from "./scorer.js";

/** The retrieval depth the gate scores at (recall@k). Matches `ask`'s default slice limit. */
export const RECALL_K = 12;
/** The recency-decay half-life (days) the gate ranks with — pinned so scores never drift with the clock. */
export const RECALL_HALF_LIFE_DAYS = 7;
/**
 * The PINNED reference time the baseline is scored at (a fixed instant just after the fixture's newest
 * record). Recency decay is measured against this, never the wall clock, so the gate is reproducible
 * forever. Stored in the baseline; the gate scores the candidate at the baseline's own `nowIso`.
 */
export const REGRESSION_NOW_ISO = "2026-07-14T00:00:00.000Z";

/** One case's recall outcome, with the raw hit counts so a number is always explainable. */
export interface CaseRecall {
  readonly question: string;
  readonly kind: QuestionClass;
  readonly recall: number;
  readonly hits: number;
  readonly expected: number;
}

/** A candidate's recall over the whole golden set: overall mean, per-cluster means, and the per-case rows. */
export interface RecallScore {
  readonly overall: number;
  readonly clusters: Readonly<Record<QuestionClass, number>>;
  readonly cases: readonly CaseRecall[];
}

/** The frozen baseline the gate compares against; written ONLY by the `rebaseline` command. */
export interface RecallBaseline {
  readonly schemaVersion: number;
  readonly metric: string;
  readonly retrieval: string;
  readonly fixture: string;
  readonly nowIso: string;
  readonly halfLifeDays: number;
  readonly k: number;
  readonly overallFloor: number;
  readonly clusterFloors: Readonly<Record<string, number>>;
  readonly cases: readonly CaseRecall[];
  /** The human justification captured the last time the baseline was deliberately moved (audit trail). */
  readonly reason: string;
}

/** One floor a candidate fell below, with the gap. */
export interface RegressionFailure {
  readonly scope: string;
  readonly floor: number;
  readonly actual: number;
  readonly delta: number;
}

/** The baseline↔candidate comparison: the two summaries + every floor the candidate missed. */
export interface RegressionDiff {
  readonly ok: boolean;
  readonly baseline: { readonly overall: number; readonly clusters: Readonly<Record<string, number>> };
  readonly candidate: { readonly overall: number; readonly clusters: Readonly<Record<string, number>> };
  readonly failures: readonly RegressionFailure[];
}

/** Float-equality slack: a candidate equal to a floor (bit-noise aside) is NOT a regression. */
const FLOOR_EPSILON = 1e-9;

const CLUSTER_KEYS: readonly QuestionClass[] = ["single-fact", "aggregation", "recency", "cross-cutting"];

/** Mean of a list; 0 for an empty list (never appears for a real cluster). */
function mean({ values }: { values: readonly number[] }): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Recall for one case: the top-k BM25×decay slice, scored against the frozen expected grounding. */
function caseRecall({
  golden,
  index,
  nowMs,
  k,
  halfLifeDays,
}: {
  golden: GoldenCase;
  index: ReturnType<typeof buildRetrievalIndex>;
  nowMs: number;
  k: number;
  halfLifeDays: number;
}): CaseRecall {
  const ids = search({
    decay: decayParamsFromDays({ days: halfLifeDays, nowMs }),
    index,
    limit: k,
    query: golden.question,
  });
  const score = scoreGrounding({
    answer: { citedTokens: [], retrievedRefs: ids.map((id) => ({ sourceId: id, token: id })) },
    expectedGrounding: golden.expectedGrounding,
  });
  return {
    expected: score.expectedCount,
    hits: score.retrievedHits,
    kind: golden.kind,
    question: golden.question,
    recall: score.retrievalRecall,
  };
}

/**
 * Score retrieval recall@k over `records` for every golden case, at a pinned reference time. Pure +
 * deterministic given its inputs.
 *
 * @param records the (frozen) corpus to retrieve over
 * @param cases the golden cases (defaults to the frozen {@link GOLDEN_CASES})
 * @param nowMs the pinned reference time for recency decay
 * @param k the recall depth (defaults to {@link RECALL_K})
 * @param halfLifeDays the decay half-life in days (defaults to {@link RECALL_HALF_LIFE_DAYS})
 * @returns the overall + per-cluster + per-case recall
 */
export function scoreRecall({
  records,
  cases = GOLDEN_CASES,
  nowMs,
  k = RECALL_K,
  halfLifeDays = RECALL_HALF_LIFE_DAYS,
}: {
  records: readonly CorpusRecord[];
  cases?: readonly GoldenCase[];
  nowMs: number;
  k?: number;
  halfLifeDays?: number;
}): RecallScore {
  const index = buildRetrievalIndex({ records });
  const rows = cases.map((golden) => caseRecall({ golden, halfLifeDays, index, k, nowMs }));
  // `as`: Object.fromEntries widens keys to string; we built it from the exhaustive CLUSTER_KEYS, so the
  // narrower QuestionClass-keyed type is sound.
  const clusters = Object.fromEntries(
    CLUSTER_KEYS.map((kind) => [kind, mean({ values: rows.filter((r) => r.kind === kind).map((r) => r.recall) })]),
  ) as Record<QuestionClass, number>;
  return { cases: rows, clusters, overall: mean({ values: rows.map((r) => r.recall) }) };
}

/**
 * Compare a candidate recall against a baseline's floors. A scope (overall, or a cluster) fails when the
 * candidate is below its floor by more than {@link FLOOR_EPSILON}. No smoothing — equal-or-better passes.
 *
 * @param candidate the freshly scored candidate recall
 * @param baseline the frozen baseline
 * @returns the diff, `ok` true when nothing regressed
 */
export function compareToBaseline({
  candidate,
  baseline,
}: {
  candidate: RecallScore;
  baseline: RecallBaseline;
}): RegressionDiff {
  const failures: RegressionFailure[] = [];
  if (candidate.overall < baseline.overallFloor - FLOOR_EPSILON) {
    failures.push({
      actual: candidate.overall,
      delta: candidate.overall - baseline.overallFloor,
      floor: baseline.overallFloor,
      scope: "overall",
    });
  }
  for (const [scope, floor] of Object.entries(baseline.clusterFloors)) {
    // `as`: cluster floors are keyed by the QuestionClass strings; index the candidate's cluster map with it.
    const actual = candidate.clusters[scope as QuestionClass];
    if (actual < floor - FLOOR_EPSILON) {
      failures.push({ actual, delta: actual - floor, floor, scope });
    }
  }
  return {
    baseline: { clusters: baseline.clusterFloors, overall: baseline.overallFloor },
    candidate: { clusters: candidate.clusters, overall: candidate.overall },
    failures,
    ok: failures.length === 0,
  };
}

/** The committed fixture path (repo-relative, resolved off this module). */
export function fixturePath(): string {
  return fileURLToPath(new URL("../../eval/fixtures/corpus.bronze.jsonl", import.meta.url));
}

/** The committed machine-baseline path (repo-relative, resolved off this module). */
export function baselinePath(): string {
  return fileURLToPath(new URL("../../eval/baseline.recall.json", import.meta.url));
}

/** The fixture's repo-relative label stored in the baseline (portable, not an absolute machine path). */
const FIXTURE_LABEL = "eval/fixtures/corpus.bronze.jsonl";

/**
 * Build a frozen baseline from a freshly scored candidate. Pure: the floors ARE the candidate's recall,
 * so re-baselining always produces a self-consistent baseline the same candidate passes. Only the
 * `rebaseline` command calls this behind its explicit authorisation.
 *
 * @param score the candidate recall to freeze as the new floors
 * @param reason the human justification for moving the baseline (audit trail)
 * @param nowIso the pinned reference time (defaults to {@link REGRESSION_NOW_ISO})
 * @returns the baseline object to persist
 */
export function buildBaseline({
  score,
  reason,
  nowIso = REGRESSION_NOW_ISO,
}: {
  score: RecallScore;
  reason: string;
  nowIso?: string;
}): RecallBaseline {
  return {
    cases: score.cases,
    clusterFloors: score.clusters,
    fixture: FIXTURE_LABEL,
    halfLifeDays: RECALL_HALF_LIFE_DAYS,
    k: RECALL_K,
    metric: `retrievalRecall@${String(RECALL_K)}`,
    nowIso,
    overallFloor: score.overall,
    reason,
    retrieval: "bm25+recency-decay (deterministic; no embedder)",
    schemaVersion: 1,
  };
}

/** Parse-edge schema for the committed baseline — turns a corrupt/out-of-shape file into a loud throw. */
const recallBaselineSchema = z.object({
  cases: z.array(
    z.object({
      expected: z.number(),
      hits: z.number(),
      kind: z.enum(["single-fact", "aggregation", "recency", "cross-cutting"]),
      question: z.string(),
      recall: z.number(),
    }),
  ),
  clusterFloors: z.record(z.string(), z.number()),
  fixture: z.string(),
  halfLifeDays: z.number(),
  k: z.number(),
  metric: z.string(),
  nowIso: z.string(),
  overallFloor: z.number(),
  reason: z.string(),
  retrieval: z.string(),
  schemaVersion: z.number(),
});

/**
 * Load + parse + validate the committed baseline. Effectful edge. A malformed baseline throws here (at the
 * edge) instead of silently poisoning the gate — the schema replaces the old unchecked cast.
 *
 * @param path the baseline path (defaults to {@link baselinePath})
 * @returns the parsed baseline
 */
export function loadBaseline({ path = baselinePath() }: { path?: string } = {}): RecallBaseline {
  return recallBaselineSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Load the frozen corpus fixture (one `CorpusRecord` JSON per line). Effectful edge; kept out of the pure
 * scorer so tests can score in-memory records.
 *
 * @param path the fixture path
 * @returns the parsed records
 */
export function loadFixtureRecords({ path }: { path: string }): readonly CorpusRecord[] {
  // `as`: the fixture is our own frozen, committed CorpusRecord JSONL (hygiene-audited) — trusted input.
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line): CorpusRecord => JSON.parse(line) as CorpusRecord);
}
