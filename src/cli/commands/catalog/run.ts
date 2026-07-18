/**
 * `slopweaver catalog` — print the command surface, derived from the SINGLE registry via
 * `discoverCommands`, so Claude (or a human) can find the right verb without loading every command module.
 * Default = the human recall view; `--json` = the machine-enumerable surface; `--capabilities` = the
 * self-describe view (documented verbs + approval/work-item hints). The renderers already existed and were
 * tested; this verb finally exposes them.
 */
import { logger } from "../../../lib/logger.js";
import { renderCapabilities, renderCatalog, renderCatalogJson } from "../../catalog.js";
import { defineCommand } from "../../defineCommand.js";
import { discoverCommands } from "../../discoverCommands.js";
import { EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { NOUN_GROUPS } from "../../nounGroups.js";
import { parseFlags } from "../../parseFlags.js";

const USAGE = "usage: slopweaver catalog [--json] [--capabilities]";

/**
 * Run the catalog verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export function runCatalog(argv: readonly string[]): number {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  // Positionals allowed (and ignored) so the bare-noun alias token doesn't trip parsing.
  const parsed = parseFlags({ allowPositionals: true, args: rest, spec: { boolean: ["json", "capabilities"] } });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      logger.error(`catalog: ${e}`);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  const commands = discoverCommands({ groups: NOUN_GROUPS });
  if (parsed.value.values["json"] === true) {
    logger.out(renderCatalogJson({ commands }));
  } else if (parsed.value.values["capabilities"] === true) {
    logger.out(renderCapabilities({ commands }));
  } else {
    logger.out(renderCatalog({ commands }));
  }
  return EXIT_OK;
}

export const catalogRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver catalog --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  run: runCatalog,
  summary: "List the command surface (human, --json, or --capabilities) from the registry",
  usage: USAGE,
});
