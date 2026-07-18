/**
 * `slopweaver dev lint` — the composed static-analysis bar (biome + prettier + oxlint + eslint + knip +
 * constraints + hygiene + door-coverage) with a single non-zero exit. Thin CLI edge over `runDevLint`;
 * the logic + tests live in `src/devLint/`.
 */
import { runDevLint } from "../../../devLint/devLint.js";
import { defineCommand } from "../../defineCommand.js";

const USAGE = "usage: slopweaver dev lint";

export const devLintCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: true,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver dev lint",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runDevLint,
  summary:
    "Run every static-analysis check (biome + prettier + oxlint + eslint + knip + constraints + hygiene + door-coverage)",
  usage: USAGE,
});
