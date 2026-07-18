/**
 * Noun/verb registry (`slopweaver <noun> <verb>`). Every noun rides the lazy-load bridge: the
 * `manifests/index.ts` barrel is the single append-only registry, folded into NOUN_GROUPS +
 * NOUN_SUMMARIES generically. Adding a noun is "add manifests/<noun>.ts + one barrel line" — this file
 * is never edited per noun.
 *
 * Importing this file (which happens on EVERY invocation) pulls in NO command module — only verb meta +
 * deferred loaders. A verb's heavy transitive deps load only when it is dispatched.
 */
import { MANIFEST_MODULES } from "./manifests/index.js";
import type { NounGroups } from "./router.js";

/** The nouns, keyed by noun, from the barrel — folded into NOUN_GROUPS. */
const MANIFEST_GROUPS = Object.fromEntries(MANIFEST_MODULES.map((m) => [m.noun, m.verbs]));

/** The nouns' summaries, from the barrel — folded into NOUN_SUMMARIES. */
const MANIFEST_SUMMARIES = Object.fromEntries(MANIFEST_MODULES.map((m) => [m.noun, m.summary]));

/** One-line summary per noun for `slopweaver <noun>` help — every noun owns its summary via the barrel. */
export const NOUN_SUMMARIES: Readonly<Record<string, string>> = MANIFEST_SUMMARIES;

export const NOUN_GROUPS: NounGroups = MANIFEST_GROUPS;
