/**
 * The owner retrieval lens (PR4.5): a FIRST-PERSON ask ("my open PRs", "what's assigned to me") is about
 * the owner, so we rewrite the retrieval query to inject the owner's cross-source identity handles (Slack
 * id, GitHub login, display name — from the PR4 identity map) and, for an enumeration intent, relax the
 * recency decay so a full "list everything of mine" reaches back further than a normal recency-weighted
 * ask. Only the RETRIEVAL query is rewritten; the answer is still composed against the original question.
 *
 * The detector deliberately EXCLUDES "we/our/ours" — the team is not the owner — so an org ask stays an
 * org ask. Pure, no I/O. When the ask is not first-person, or no owner handles are known, this is a
 * transparent pass-through (query + decay unchanged, `ownerScoped: false`), which keeps org retrieval
 * byte-identical.
 */
import { DEFAULT_HALF_LIFE_MS, type DecayParams } from "./recencyDecay.js";

/** How much to relax the recency half-life for an owner enumeration ("all my …") intent. */
const ENUMERATION_HALF_LIFE_MULTIPLIER = 6;

/**
 * The owner's cross-source identity: a stable person id + the deduped handles (native ids / handles /
 * names) that name them across GitHub / Slack / Linear / Notion. Injected into a first-person query.
 */
export interface OwnerIdentity {
  readonly personId: string;
  readonly handles: readonly string[];
}

/**
 * First-person OWNED markers: `my`, `mine`, `assigned to me`, `by me`, and `I own|lead|manage|run|drive`.
 * Word-anchored so "my" never fires inside another word — and, crucially, "we"/"our"/"ours" match none of
 * these, so a team ask ("what did we ship") is never mistaken for an owner ask.
 */
const FIRST_PERSON_OWNED = /\bmy\b|\bmine\b|\bassigned to me\b|\bby me\b|\bi (?:own|lead|manage|run|drive)\b/i;

/** Enumeration intents ("list/all my open PRs") that justify relaxing recency for a fuller sweep. */
const ENUMERATION_INTENT =
  /\b(?:all|every|list|open|outstanding|pending|assigned|unresolved|todo|todos|backlog|prs?|issues?|tickets?|reviews?)\b/i;

/**
 * Classify an ask: is it first-person owned, and is it an enumeration intent? Pure. "we/our/ours" never
 * triggers `firstPersonOwned`.
 *
 * @param question the raw question text
 * @returns whether the ask is first-person owned + whether it is an enumeration intent
 */
export function classifyOwnerAsk({ question }: { question: string }): {
  firstPersonOwned: boolean;
  enumeration: boolean;
} {
  const firstPersonOwned = FIRST_PERSON_OWNED.test(question);
  return { enumeration: firstPersonOwned && ENUMERATION_INTENT.test(question), firstPersonOwned };
}

/** Relax a decay's half-life by the enumeration multiplier (defaulting an unset half-life first). Pure. */
function relaxDecay({ decay }: { decay: DecayParams }): DecayParams {
  return { ...decay, halfLifeMs: (decay.halfLifeMs ?? DEFAULT_HALF_LIFE_MS) * ENUMERATION_HALF_LIFE_MULTIPLIER };
}

/**
 * Plan owner-scoped retrieval for an ask. When it is first-person owned AND the owner's handles are known,
 * append the deduped handles to the retrieval query and (for an enumeration intent) relax the recency
 * decay. Otherwise a transparent pass-through — query + decay unchanged, `ownerScoped: false` — so an
 * ordinary org ask is behaviourally identical to before the lens existed.
 *
 * @param question the original question (used verbatim for the answer prompt by the caller)
 * @param owner the owner's cross-source identity, when resolved
 * @param decay the base recency-decay params, when set
 * @returns the retrieval query, the (possibly relaxed) decay, and whether the owner lens engaged
 */
export function planOwnerRetrieval({
  question,
  owner,
  decay,
}: {
  question: string;
  owner: OwnerIdentity | undefined;
  decay: DecayParams | undefined;
}): { query: string; decay?: DecayParams; ownerScoped: boolean } {
  const { firstPersonOwned, enumeration } = classifyOwnerAsk({ question });
  if (!firstPersonOwned || owner === undefined || owner.handles.length === 0) {
    return { ownerScoped: false, query: question, ...(decay !== undefined ? { decay } : {}) };
  }
  const query = `${question} ${owner.handles.join(" ")}`;
  const planned = enumeration && decay !== undefined ? relaxDecay({ decay }) : decay;
  return { ownerScoped: true, query, ...(planned !== undefined ? { decay: planned } : {}) };
}
