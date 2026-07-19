/**
 * The boundary-residue gate entry point — nothing but the top-level invocation (run by `dev lint`). The
 * scanner logic + its exports live in `boundaryResidue.ts`; this file existing IS the invocation, so there
 * is no `isDirectInvocation` guard.
 */
import { runBoundaryResidue } from "./boundaryResidue.js";

process.exit(runBoundaryResidue());
