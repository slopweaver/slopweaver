/**
 * The re-baseline entry point — nothing but the top-level invocation (run via `yarn eval:rebaseline`).
 * All logic + its tests live in `rebaselineCore.ts`; this file existing IS the invocation, so there is no
 * `isDirectInvocation` guard.
 */
import { runRebaseline } from "./rebaselineCore.js";

process.exit(runRebaseline(process.argv));
