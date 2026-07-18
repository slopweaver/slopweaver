#!/usr/bin/env node
/**
 * The `slopweaver` CLI entry point — nothing but the top-level invocation. All logic lives in `main.ts`
 * (importable + testable); this file existing IS the direct invocation, so there is no `isDirectInvocation`
 * guard to reason about.
 */
import { runCliProcess } from "./main.js";

void runCliProcess();
