/**
 * The coverage-ratchet gate entry point — nothing but the top-level invocation (run by `dev lint` with
 * `--summary-only`, and standalone as `yarn coverage:ratchet` / `--rebaseline`). The logic + its exports
 * live in `coverageRatchet.ts`; this file existing IS the invocation (no `isDirectInvocation` guard).
 */
import { runCoverageRatchet } from "./coverageRatchet.js";

process.exit(runCoverageRatchet(process.argv));
