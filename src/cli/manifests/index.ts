/**
 * The noun BARREL — the single append-only registration point for every noun on the lazy-load bridge.
 * `nounGroups.ts` folds this array into `NOUN_GROUPS` + `NOUN_SUMMARIES` generically, so adding a noun
 * never edits that central registry's import-and-assign list.
 *
 * To add a noun: write `cli/manifests/<noun>.ts` (its lazy verb map), then append ONE
 * `{ noun, summary, verbs }` line below. That is the whole edit.
 *
 * Pure: importing the barrel imports only manifest modules (metadata-only — no command module loads).
 * The first command `import()` fires only on a verb's `load()`.
 */

import type { NounManifestModule } from "../manifest.js";
import { askManifest } from "./ask.js";
import { catalogManifest } from "./catalog.js";
import { deriveManifest } from "./derive.js";
import { devManifest } from "./dev.js";
import { distilManifest } from "./distil.js";
import { doctorManifest } from "./doctor.js";
import { factsManifest } from "./facts.js";
import { identityManifest } from "./identity.js";
import { initManifest } from "./init.js";
import { refreshManifest } from "./refresh.js";

export const MANIFEST_MODULES: readonly NounManifestModule[] = [
  {
    noun: "doctor",
    summary: "Env preflight: plugin version + the resolved state home and its layout",
    verbs: doctorManifest,
  },
  {
    noun: "init",
    summary: "Scaffold $SLOPWEAVER_HOME (idempotent): corpus/beliefs/ledgers dirs + seed files",
    verbs: initManifest,
  },
  {
    noun: "refresh",
    summary: "Ingest recent GitHub activity into the local bronze corpus",
    verbs: refreshManifest,
  },
  {
    noun: "derive",
    summary: "Derive deterministic silver (directory + graph + opportunities) from the corpus",
    verbs: deriveManifest,
  },
  {
    noun: "distil",
    summary: "Distil the corpus into gold (LLM map-reduce; caches per batch)",
    verbs: distilManifest,
  },
  {
    noun: "ask",
    summary: "Ask a grounded question of your local world model",
    verbs: askManifest,
  },
  {
    noun: "facts",
    summary: "Retrieve the ranked record slice for a question (no LLM)",
    verbs: factsManifest,
  },
  {
    noun: "identity",
    summary: "Resolve the same human across GitHub/Slack/Linear/Notion into one canonical person",
    verbs: identityManifest,
  },
  {
    noun: "dev",
    summary: "Repo-development verbs (the PR gate)",
    verbs: devManifest,
  },
  {
    noun: "catalog",
    summary: "List the command surface (human, --json, or --capabilities) from the registry",
    verbs: catalogManifest,
  },
];
