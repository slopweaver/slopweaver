/**
 * `slopweaver derive` — the free, deterministic silver synthesis. Reads the bronze corpus, builds the
 * directory + cross-ref graph + opportunities, and writes them under `corpus/silver/`. No LLM, no
 * network — cheap enough to re-run in full every time. `--dry-run` prints the summary without writing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slopweaverHome } from "../../../config.js";
import { silverGraphDir, silverIndexDir } from "../../../corpus/corpusPaths.js";
import { readCorpusDir, resolveCorpusDir } from "../../../corpus/corpusStore.js";
import { writeJsonFile } from "../../../lib/jsonFile.js";
import { logger } from "../../../lib/logger.js";
import { deriveSilver, planDeriveSummary } from "../../../silver/derive.js";
import { buildIdentityMap, type IdentityMap, parseIdentityRecords } from "../../../silver/identity.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

const USAGE = "usage: slopweaver derive [--home <dir>] [--corpus <dir>] [--top N] [--dry-run]";
const DEFAULT_TOP = 20;

/** Load the identity map from the silver index (empty when absent). */
function loadIdentityMap({ home }: { home: string }): IdentityMap {
  let content = "[]";
  try {
    content = readFileSync(join(silverIndexDir({ home }), "identities.json"), "utf8");
  } catch {
    // no roster yet — handles pass through verbatim
  }
  return buildIdentityMap({ records: parseIdentityRecords({ content }) });
}

/**
 * Run the derive verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export function runDerive(argv: readonly string[]): number {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const parsed = parseFlagTail({ rest, spec: { boolean: ["dry-run"], value: ["home", "corpus", "top"] } });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  const { values, flags } = parsed.value;
  const home = values["home"] ?? slopweaverHome();

  const flagErrors: string[] = [];
  const top =
    values["top"] !== undefined
      ? parsePositiveInteger({ errors: flagErrors, label: "--top", value: values["top"] })
      : DEFAULT_TOP;
  if (flagErrors.length > 0) {
    flagErrors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_USAGE;
  }

  const dir = resolveCorpusDir({ home, ...(values["corpus"] !== undefined ? { corpus: values["corpus"] } : {}) });
  if (dir.ok === false) {
    dir.errors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_ERROR;
  }
  const read = readCorpusDir({ dir: dir.value });
  read.warnings.forEach((w) => {
    logger.warn(w);
  });

  const artifacts = deriveSilver({ identityMap: loadIdentityMap({ home }), records: read.ok ? read.value : [] });

  if (!flags.has("dry-run")) {
    const indexDir = silverIndexDir({ home });
    writeJsonFile({ path: join(indexDir, "directory.json"), value: artifacts.directory });
    writeJsonFile({ path: join(indexDir, "opportunities.json"), value: artifacts.opportunities });
    writeJsonFile({ path: join(silverGraphDir({ home }), "graph.json"), value: artifacts.graph });
  }

  planDeriveSummary({ artifacts, top }).forEach((line) => {
    logger.out(line);
  });
  logger.out(flags.has("dry-run") ? "(dry run — nothing written)" : `wrote silver → ${silverIndexDir({ home })}`);
  return EXIT_OK;
}

export const deriveRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver derive",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runDerive,
  summary: "Derive deterministic silver (directory + graph + opportunities) from the corpus",
  usage: USAGE,
});
