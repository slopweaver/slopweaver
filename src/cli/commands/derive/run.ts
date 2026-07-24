/**
 * `slopweaver derive` — the free, deterministic silver synthesis. Reads the bronze corpus, builds the
 * directory + cross-ref graph + opportunities + the cross-source identity resolution, and writes them
 * under `corpus/silver/`. No LLM, no network — cheap enough to re-run in full every time. `--dry-run`
 * prints the summary without writing.
 *
 * The identity roster is the off-repo `$SLOPWEAVER_HOME/identity.json` (the human override/seed); the
 * DERIVED cross-source map is written to `silver/index/identities.json` for PR10/PR18 to consume.
 */
import { join } from "node:path";
import { progressJsonEnabled, slopweaverHome } from "../../../config.js";
import {
  silverGraphDir,
  silverIdentitiesPath,
  silverIndexDir,
  silverPeoplePath,
  silverStructuresPath,
} from "../../../corpus/corpusPaths.js";
import { readCorpusDir, resolveCorpusDir } from "../../../corpus/corpusStore.js";
import { memberIdentityCandidates } from "../../../corpus/members/project.js";
import { readAllMembers } from "../../../corpus/members/store.js";
import type { MemberBronzeRow } from "../../../corpus/members/types.js";
import { readAllStructures } from "../../../corpus/structures/store.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { writeJsonFile } from "../../../lib/jsonFile.js";
import { logger } from "../../../lib/logger.js";
import {
  createRichProgressEmitter,
  DEFAULT_PROGRESS_CONFIG,
  type ProgressSink,
  type RichProgressEmitter,
} from "../../../lib/progress.js";
import { deriveSilver, planDeriveSummary } from "../../../silver/derive.js";
import {
  buildIdentityMap,
  type IdentityMap,
  type IdentityRecord,
  type IdentityResolution,
} from "../../../silver/identity.js";
import { loadIdentityRoster } from "../../../silver/loadIdentityRoster.js";
import { buildPersonDossiers } from "../../../silver/personDossier.js";
import { resolveFromRecords } from "../../../silver/personResolver.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

const USAGE = "usage: slopweaver derive [--home <dir>] [--corpus <dir>] [--top N] [--dry-run]";
const DEFAULT_TOP = 20;

/**
 * Build the legacy handle map + the canonical cross-source resolution from the corpus + roster + hydrated
 * MEMBERS, with progress. The member rows feed the resolver's email tier (via {@link memberIdentityCandidates}),
 * so the whole team auto-links cross-source — not just the roster-seeded human.
 */
function buildResolution({
  records,
  roster,
  memberRows,
  emitter,
}: {
  records: readonly CorpusRecord[];
  roster: readonly IdentityRecord[];
  memberRows: readonly MemberBronzeRow[];
  emitter: RichProgressEmitter;
}): { identityMap: IdentityMap; resolution: IdentityResolution } {
  emitter.emit({ done: 0, lane: "heartbeat", phase: "resolve-identities", total: records.length });
  const resolution = resolveFromRecords({
    extraCandidates: memberIdentityCandidates({ rows: memberRows }),
    records,
    roster,
  });
  const linked = resolution.people.filter((person) => person.confidence !== "single-source").length;
  emitter.emit({
    done: resolution.people.length,
    lane: "heartbeat",
    metrics: {
      conflicts: resolution.conflicts.length,
      held: resolution.candidates.length,
      linked,
      members: memberRows.length,
    },
    phase: "resolve-identities",
    total: records.length,
  });
  return { identityMap: buildIdentityMap({ records: roster }), resolution };
}

/** The write-to-disk shape of the resolution — drops the derived `index` (a rebuildable lookup). */
function serialisableResolution({ resolution }: { resolution: IdentityResolution }): unknown {
  return { candidates: resolution.candidates, conflicts: resolution.conflicts, people: resolution.people };
}

/** Write the five silver artifacts under `corpus/silver/` (incl. the PR4.1 person dossier `people.json`). */
function writeArtifacts({
  home,
  artifacts,
  memberRows,
}: {
  home: string;
  artifacts: ReturnType<typeof deriveSilver>;
  memberRows: readonly MemberBronzeRow[];
}): void {
  const indexDir = silverIndexDir({ home });
  writeJsonFile({ path: join(indexDir, "directory.json"), value: artifacts.directory });
  writeJsonFile({ path: join(indexDir, "opportunities.json"), value: artifacts.opportunities });
  writeJsonFile({
    path: silverIdentitiesPath({ home }),
    value: serialisableResolution({ resolution: artifacts.identities }),
  });
  writeJsonFile({
    path: silverPeoplePath({ home }),
    value: { people: buildPersonDossiers({ memberRows, people: artifacts.identities.people }) },
  });
  writeJsonFile({ path: silverStructuresPath({ home }), value: artifacts.structures });
  writeJsonFile({ path: join(silverGraphDir({ home }), "graph.json"), value: artifacts.graph });
  writeJsonFile({ path: join(silverGraphDir({ home }), "curated.json"), value: artifacts.curated });
}

/**
 * Run the derive verb over an optional injected progress sink (the testable seam).
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @param sink where progress lines go (defaults to stdout)
 * @returns the process exit code
 */
/** The validated derive args. */
interface DeriveArgs {
  readonly home: string;
  readonly corpus?: string;
  readonly top: number;
  readonly dryRun: boolean;
}

/** Parse + validate the derive flag tail (printing errors), or the usage exit code to return. */
function parseDeriveArgs({ rest }: { rest: readonly string[] }): { args: DeriveArgs } | { code: number } {
  const parsed = parseFlagTail({ rest, spec: { boolean: ["dry-run"], value: ["home", "corpus", "top"] } });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return { code: EXIT_USAGE };
  }
  const { values, flags } = parsed.value;
  const flagErrors: string[] = [];
  const top =
    values["top"] !== undefined
      ? parsePositiveInteger({ errors: flagErrors, label: "--top", value: values["top"] })
      : DEFAULT_TOP;
  if (flagErrors.length > 0) {
    flagErrors.forEach((e) => {
      logger.error(e);
    });
    return { code: EXIT_USAGE };
  }
  return {
    args: {
      dryRun: flags.has("dry-run"),
      home: values["home"] ?? slopweaverHome(),
      top,
      ...(values["corpus"] !== undefined ? { corpus: values["corpus"] } : {}),
    },
  };
}

export function runDeriveWithDeps({ argv, sink }: { argv: readonly string[]; sink?: ProgressSink }): number {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const parsed = parseDeriveArgs({ rest });
  if ("code" in parsed) {
    return parsed.code;
  }
  const { home, top, dryRun, corpus } = parsed.args;

  const dir = resolveCorpusDir({ home, ...(corpus !== undefined ? { corpus } : {}) });
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

  const records = read.ok ? read.value : [];
  const members = readAllMembers({ home });
  members.warnings.forEach((w) => {
    logger.warn(w);
  });
  const structures = readAllStructures({ home });
  structures.warnings.forEach((w) => {
    logger.warn(w);
  });
  return deriveAndReport({
    dryRun,
    home,
    memberRows: members.rows,
    records,
    structureRows: structures.rows,
    top,
    ...(sink !== undefined ? { sink } : {}),
  });
}

/**
 * Run the deterministic synthesis with staged heartbeats, write the silver artifacts (unless `--dry-run`),
 * and print the summary. Derive is fast, so its stages are UNthrottled — each is a distinct, watchable step,
 * not a flood. Machine JSON goes to the injected `sink` (tests) or stderr (production); stdout stays clean,
 * and there's no learnings lane (derive does no LLM extraction). The effectful synthesis half of the shell.
 *
 * @returns the process exit code
 */
function deriveAndReport({
  records,
  memberRows,
  structureRows,
  home,
  top,
  dryRun,
  sink,
}: {
  records: readonly CorpusRecord[];
  memberRows: readonly MemberBronzeRow[];
  structureRows: ReturnType<typeof readAllStructures>["rows"];
  home: string;
  top: number;
  dryRun: boolean;
  sink?: ProgressSink;
}): number {
  const emitter = createRichProgressEmitter({
    config: { ...DEFAULT_PROGRESS_CONFIG, heartbeatMs: 0 },
    verb: "derive",
    // When a machine sink is injected (tests), silence the human lane so a unit test does no real stderr I/O
    // and its assertions see only machine JSON. Production (no sink) keeps human lines on stderr, with the
    // machine JSON lane off unless opted in (so the watch view is clean).
    ...(sink !== undefined
      ? { humanSink: () => {}, machineSink: sink }
      : progressJsonEnabled()
        ? {}
        : { machineSink: () => {} }),
  });
  emitter.emit({ done: records.length, lane: "heartbeat", phase: "read-corpus" });
  const { identityMap, resolution } = buildResolution({
    emitter,
    memberRows,
    records,
    roster: loadIdentityRoster({ home }),
  });
  resolution.conflicts.forEach((conflict) => {
    logger.warn(`identity conflict: ${conflict}`);
  });
  emitter.emit({ lane: "heartbeat", phase: "build-directory" });
  const artifacts = deriveSilver({ identityMap, records, resolution, structureRows });
  emitter.emit({ lane: "heartbeat", metrics: { edges: artifacts.graph.edges.length }, phase: "build-graphs" });
  if (artifacts.curated.capped > 0) {
    logger.warn(`curated graph: dropped ${String(artifacts.curated.capped)} edge(s) over the per-record cap`);
  }
  if (!dryRun) {
    writeArtifacts({ artifacts, home, memberRows });
  }
  emitter.finish({ lane: "heartbeat", phase: "write-silver" });
  planDeriveSummary({ artifacts, top }).forEach((line) => {
    logger.out(line);
  });
  logger.out(dryRun ? "(dry run — nothing written)" : `wrote silver → ${silverIndexDir({ home })}`);
  return EXIT_OK;
}

/**
 * Run the derive verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export function runDerive(argv: readonly string[]): number {
  return runDeriveWithDeps({ argv });
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
