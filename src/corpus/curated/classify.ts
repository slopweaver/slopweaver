/**
 * The curated-artefact classifier: a cheap, deterministic heuristic that tags a record
 * `strategy | decision | status | ownership` so gold (and later the belief layer) can weight the
 * deliberately-authored artefacts above the firehose. Runs at projection time — NO LLM call, no cache,
 * no network (the token cost + failure mode of an LLM tag isn't worth it for first-order weighting).
 *
 * The rule is two-stage and pure: a strongly-typed KIND default wins first (a Linear project-update is
 * always `status`, a CODEOWNERS file is always `ownership`), then — for the ambiguous kinds (discussion,
 * page, document, comment) — an author-intent KEYWORD scan of the title + text decides, else no tag.
 */
import type { CorpusKind } from "../types.js";
import type { CuratedClassification } from "./types.js";

/** Kinds whose classification is unambiguous from the kind alone (the author already declared intent). */
const KIND_DEFAULTS: Readonly<Partial<Record<CorpusKind, CuratedClassification>>> = {
  canvas: "strategy",
  codeowners: "ownership",
  initiative: "strategy",
  release: "status",
  update: "status",
};

/** Keyword → classification rules, scanned in priority order (first match wins). Author-intent signal. */
const KEYWORD_RULES: readonly { readonly pattern: RegExp; readonly classification: CuratedClassification }[] = [
  { classification: "ownership", pattern: /\b(codeowners|code owners|owned by|ownership|responsible for)\b/i },
  { classification: "decision", pattern: /\b(adr|rfc|decision|decided|we will|we chose|proposal|trade-?off)\b/i },
  {
    classification: "status",
    pattern: /\b(status update|weekly update|progress update|on track|off track|at risk)\b/i,
  },
  { classification: "strategy", pattern: /\b(strategy|strategic|roadmap|vision|north star|okrs?|objectives?)\b/i },
];

/**
 * Classify a curated artefact into a weighting tag, or `undefined` when nothing matches (most firehose
 * records stay untagged). Pure + deterministic.
 *
 * @param kind the record kind
 * @param title the record title (may be empty)
 * @param text the record body
 * @returns the classification, or undefined when no rule fires
 */
export function classifyCurated({
  kind,
  title,
  text,
}: {
  kind: CorpusKind;
  title?: string;
  text: string;
}): CuratedClassification | undefined {
  const byKind = KIND_DEFAULTS[kind];
  if (byKind !== undefined) {
    return byKind;
  }
  const haystack = [title, text].filter((part) => part !== undefined && part.length > 0).join("\n");
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(haystack)) {
      return rule.classification;
    }
  }
  return undefined;
}
