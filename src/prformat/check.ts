/**
 * The PR-format gate entry point — nothing but the top-level invocation (run via `yarn check:pr-format`).
 * All logic lives in `checkCore.ts` (importable + tested); this file existing IS the invocation, so there
 * is no `isDirectInvocation` guard.
 */
import { runCheck } from "./checkCore.js";

process.exit(runCheck());
