/**
 * `slopweaver identity` — read-only cross-source identity resolution. `show` prints every canonical
 * person (their per-source ids + how each was linked); `resolve <raw>` maps one raw handle/id to its
 * canonical person. Both recompute the resolution LIVE from the current corpus + the off-repo
 * `$SLOPWEAVER_HOME/identity.json` roster, so the answer always reflects present state (no prior derive
 * required). No writes, no SDK/LLM calls — `requiresApproval: false`, `effect: "none"`.
 *
 * A thin effectful shell: the corpus + roster reads are INJECTED (fakes in tests, production wiring in
 * {@link runIdentityShow} / {@link runIdentityResolve}); the resolution + rendering are the pure cores.
 */
import { slopweaverHome } from "../../../config.js";
import { readCorpusDir, resolveCorpusDir } from "../../../corpus/corpusStore.js";
import { memberIdentityCandidates } from "../../../corpus/members/project.js";
import { readAllMembers } from "../../../corpus/members/store.js";
import type { MemberBronzeRow } from "../../../corpus/members/types.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { logger } from "../../../lib/logger.js";
import type { IdentityRecord } from "../../../silver/identity.js";
import { loadIdentityRoster } from "../../../silver/loadIdentityRoster.js";
import { resolveFromRecords, resolvePersonForRaw } from "../../../silver/personResolver.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlags } from "../../parseFlags.js";
import { peopleToJson, personToJson, renderPeople, renderPersonBlock } from "./core.js";

const SHOW_USAGE = "usage: slopweaver identity show [<handle|id>] [--home <dir>] [--corpus <dir>] [--json]";
const RESOLVE_USAGE = "usage: slopweaver identity resolve <handle|id> [--home <dir>] [--corpus <dir>] [--json]";

/** The value of a string flag, or `undefined` (parseArgs may hand back a boolean for a value-less flag). */
function strFlag({
  values,
  key,
}: {
  values: Readonly<Record<string, string | boolean>>;
  key: string;
}): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

/** The injectable effectful seams the `identity` shells compose (fakes in tests). */
export interface IdentityDeps {
  readonly home: () => string;
  readonly loadRoster: (args: { home: string }) => readonly IdentityRecord[];
  readonly loadRecords: (args: { home: string; corpus?: string }) => {
    records: readonly CorpusRecord[];
    warnings: readonly string[];
  };
  /** Hydrated member rows (PR4.1) — fed to the resolver's email tier so `show` unifies without a prior derive. */
  readonly loadMembers: (args: { home: string }) => { rows: readonly MemberBronzeRow[]; warnings: readonly string[] };
  readonly logger: { out: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/** Drop a leading verb word (`show`/`resolve`) so bare `identity` and explicit `identity show` both parse. */
function verbTail({ argv, verb }: { argv: readonly string[]; verb: string }): readonly string[] {
  const rest = argv.slice(3);
  return rest[0] === verb ? rest.slice(1) : rest;
}

/** Load corpus + members + roster and resolve them into canonical people (warnings surfaced through the logger). */
function resolveFor({
  deps,
  home,
  corpus,
}: {
  deps: IdentityDeps;
  home: string;
  corpus: string | undefined;
}): ReturnType<typeof resolveFromRecords> {
  const loaded = deps.loadRecords({ home, ...(corpus !== undefined ? { corpus } : {}) });
  const members = deps.loadMembers({ home });
  [...loaded.warnings, ...members.warnings].forEach((w) => {
    deps.logger.warn(w);
  });
  return resolveFromRecords({
    extraCandidates: memberIdentityCandidates({ rows: members.rows }),
    records: loaded.records,
    roster: deps.loadRoster({ home }),
  });
}

/**
 * Run `identity show [<who>]` over injected dependencies — the testable shell. With no positional it lists
 * every canonical person; with one it filters to that person (`EXIT_EXPECTED_EMPTY` when unknown).
 *
 * @param argv the full process argv
 * @param deps the effectful seams
 * @returns the process exit code
 */
export function runIdentityShowWithDeps({ argv, deps }: { argv: readonly string[]; deps: IdentityDeps }): number {
  const rest = verbTail({ argv, verb: "show" });
  if (rest.includes("--help") || rest.includes("-h")) {
    deps.logger.out(SHOW_USAGE);
    return EXIT_OK;
  }
  const parsed = parseFlags({
    allowPositionals: true,
    args: rest,
    spec: { boolean: ["json"], string: ["corpus", "home"] },
  });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      deps.logger.error(e);
    });
    deps.logger.error(SHOW_USAGE);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed.value;
  const home = strFlag({ key: "home", values }) ?? deps.home();
  const resolution = resolveFor({ corpus: strFlag({ key: "corpus", values }), deps, home });
  const json = values["json"] === true;
  const who = positionals[0];
  if (who !== undefined) {
    return emitPerson({ deps, json, person: resolvePersonForRaw({ raw: who, resolution }), raw: who });
  }
  if (json) {
    deps.logger.out(JSON.stringify(peopleToJson({ resolution }), null, 2));
  } else {
    renderPeople({ resolution }).forEach((line) => {
      deps.logger.out(line);
    });
  }
  return EXIT_OK;
}

/** Emit one resolved person (or a not-found signal). Shared by `show <who>` + `resolve <raw>`. */
function emitPerson({
  deps,
  person,
  raw,
  json,
}: {
  deps: IdentityDeps;
  person: ReturnType<typeof resolvePersonForRaw>;
  raw: string;
  json: boolean;
}): number {
  if (person === undefined) {
    deps.logger.out(`no canonical person for "${raw}"`);
    return EXIT_EXPECTED_EMPTY;
  }
  if (json) {
    deps.logger.out(JSON.stringify(personToJson({ person }), null, 2));
  } else {
    renderPersonBlock({ person }).forEach((line) => {
      deps.logger.out(line);
    });
  }
  return EXIT_OK;
}

/**
 * Run `identity resolve <raw>` over injected dependencies — the testable shell. Exits `EXIT_EXPECTED_EMPTY`
 * (a deliberate signal, not a fault) when the token maps to no known person.
 *
 * @param argv the full process argv
 * @param deps the effectful seams
 * @returns the process exit code
 */
export function runIdentityResolveWithDeps({ argv, deps }: { argv: readonly string[]; deps: IdentityDeps }): number {
  const rest = verbTail({ argv, verb: "resolve" });
  if (rest.includes("--help") || rest.includes("-h")) {
    deps.logger.out(RESOLVE_USAGE);
    return EXIT_OK;
  }
  const parsed = parseFlags({
    allowPositionals: true,
    args: rest,
    spec: { boolean: ["json"], string: ["corpus", "home"] },
  });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      deps.logger.error(e);
    });
    deps.logger.error(RESOLVE_USAGE);
    return EXIT_USAGE;
  }
  const raw = parsed.value.positionals[0];
  if (raw === undefined) {
    deps.logger.error("resolve needs a handle or id");
    deps.logger.error(RESOLVE_USAGE);
    return EXIT_USAGE;
  }
  const home = strFlag({ key: "home", values: parsed.value.values }) ?? deps.home();
  const resolution = resolveFor({ corpus: strFlag({ key: "corpus", values: parsed.value.values }), deps, home });
  return emitPerson({
    deps,
    json: parsed.value.values["json"] === true,
    person: resolvePersonForRaw({ raw, resolution }),
    raw,
  });
}

/** Production dependencies: real roster + corpus reads. */
function productionIdentityDeps(): IdentityDeps {
  return {
    home: slopweaverHome,
    loadMembers: ({ home }) => readAllMembers({ home }),
    loadRecords: ({ home, corpus }) => {
      const dir = resolveCorpusDir({ home, ...(corpus !== undefined ? { corpus } : {}) });
      if (dir.ok === false) {
        return { records: [], warnings: dir.errors };
      }
      const read = readCorpusDir({ dir: dir.value });
      return { records: read.ok ? read.value : [], warnings: read.warnings };
    },
    loadRoster: loadIdentityRoster,
    logger: {
      error: (m) => {
        logger.error(m);
      },
      out: (m) => {
        logger.out(m);
      },
      warn: (m) => {
        logger.warn(m);
      },
    },
  };
}

/**
 * Run `identity show`.
 *
 * @param argv the full process argv
 * @returns the process exit code
 */
export function runIdentityShow(argv: readonly string[]): number {
  return runIdentityShowWithDeps({ argv, deps: productionIdentityDeps() });
}

/**
 * Run `identity resolve`.
 *
 * @param argv the full process argv
 * @returns the process exit code
 */
export function runIdentityResolve(argv: readonly string[]): number {
  return runIdentityResolveWithDeps({ argv, deps: productionIdentityDeps() });
}

export const identityShowCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver identity show --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  run: runIdentityShow,
  summary: "Show every canonical person: their per-source ids + how each was linked",
  usage: SHOW_USAGE,
});

export const identityResolveCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: true,
  effect: "none",
  example: "slopweaver identity resolve @ada",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  run: runIdentityResolve,
  summary: "Resolve a raw handle/id to its canonical cross-source person",
  usage: RESOLVE_USAGE,
});
