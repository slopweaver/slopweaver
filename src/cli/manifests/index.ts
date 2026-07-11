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
import { doctorManifest } from './doctor.js'
import type { NounManifestModule } from '../manifest.js'

export const MANIFEST_MODULES: readonly NounManifestModule[] = [
  {
    noun: 'doctor',
    summary: 'Env preflight: print the plugin version + resolved SLOPWEAVER_HOME',
    verbs: doctorManifest,
  },
]
