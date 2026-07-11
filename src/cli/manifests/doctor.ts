/**
 * Lazy manifest for the `doctor` noun (env preflight; see `cli/manifest.ts`).
 *
 * The bare-noun and `run` verb resolve to the SAME handler, so both entries share one loader (one module
 * fetch). As lazy entries the meta rides here (enumeration stays import-free) and the module loads only
 * when dispatched. Pure: declaring this manifest imports no command module — the `import()` fires only on
 * a verb's `load()`.
 */
import { lazy, type VerbManifestEntry } from '../manifest.js'

/** Shared meta for the bare-noun + `run` verb; both resolve to the same preflight handler. */
const doctorMeta = {
  summary: 'Env preflight: print the plugin version + resolved SLOPWEAVER_HOME',
  usage: 'usage: slopweaver doctor',
  example: 'slopweaver doctor',
  // The reject path is I/O-free; a non-zero exit REPORTS a broken env (a finding), not a broken tool.
  parseRejectIsIoFree: true,
  diagnostic: true,
} as const

/** Lazy loader for the shared doctor handler — one module fetch, reused across the bare-noun + `run` verb. */
const loadDoctor = () => import('../commands/doctor/run.js').then((m) => m.doctorRunCommand)

/** The `doctor` noun's verbs as lazy manifest entries. */
export const doctorManifest: Readonly<Record<string, VerbManifestEntry>> = {
  '': lazy({ meta: doctorMeta, load: loadDoctor }),
  run: lazy({ meta: doctorMeta, load: loadDoctor }),
}
