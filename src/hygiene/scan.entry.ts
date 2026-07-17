/**
 * The hygiene-gate entry point — nothing but the top-level invocation (run by `scripts/check-hygiene.sh`).
 * The scanner logic + its exports live in `scan.ts`; this file existing IS the invocation, so there is no
 * `isDirectInvocation` guard.
 */
import { runScan } from './scan.js'

process.exit(runScan())
