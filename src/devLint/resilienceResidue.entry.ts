/**
 * The resilience-residue gate entry point — nothing but the top-level invocation (run by `dev lint`).
 * The scanner logic + its exports live in `resilienceResidue.ts`; this file existing IS the invocation,
 * so there is no `isDirectInvocation` guard.
 */
import { runResilienceResidue } from "./resilienceResidue.js";

process.exit(runResilienceResidue());
