/**
 * `slopweaver doctor` — the env preflight. Prints the plugin version, the resolved state home, its layout
 * version, and the presence/emptiness of each part of the home (corpus roots, beliefs, ledgers, identity,
 * profile, denylist). Read-only: it reports status, it never scaffolds (that is `slopweaver init`) and it
 * never prints identity/profile CONTENTS — only whether they parse. All paths come from `stateHomePaths`.
 *
 * v0.1 has no hard native dependencies, so a healthy env exits 0; the `diagnostic` meta reserves the
 * non-zero-is-a-finding channel for the probes later PRs add.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "../../../lib/jsonFile.js";
import { logger } from "../../../lib/logger.js";
import { isRecord } from "../../../lib/parsers.js";
import { parseProfile } from "../../../profile.js";
import { stateHomePaths } from "../../../stateHome.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_OK } from "../../exitCodes.js";

const USAGE = "usage: slopweaver doctor [--json]";

/** Read the plugin version from the package manifest at the repo root (resolves identically under tsx + dist). */
function pluginVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));
    return isRecord(parsed) && typeof parsed["version"] === "string" ? parsed["version"] : "unknown";
  } catch {
    return "unknown";
  }
}

/** `exists` + `(empty)` when a present directory has no entries — reveals scaffolded-but-unpopulated dirs. */
function dirStatus({ path }: { path: string }): string {
  if (!existsSync(path)) {
    return "missing";
  }
  try {
    return readdirSync(path).length === 0 ? "exists (empty)" : "exists";
  } catch {
    return "exists";
  }
}

/** The home-version marker's value, or a not-initialised note. */
function homeVersionLine({ path }: { path: string }): string {
  const parsed = readJsonFile({ path });
  if (isRecord(parsed) && typeof parsed["version"] === "number") {
    return `home version: ${String(parsed["version"])}`;
  }
  return "home version: not initialised — run `slopweaver init`";
}

/** Parse-status of profile.json: missing / valid / invalid (with the reason), never its contents. */
function profileLine({ path }: { path: string }): string {
  if (!existsSync(path)) {
    return "profile.json: missing — run `slopweaver init`";
  }
  const result = parseProfile({ value: readJsonFile({ path }) });
  return result.ok ? "profile.json: present (valid)" : `profile.json: present (INVALID: ${result.errors.join("; ")})`;
}

/** Parse-status of identity.json: the identity map is a JSON array; report present/valid/invalid only. */
function identityLine({ path }: { path: string }): string {
  if (!existsSync(path)) {
    return "identity.json: missing — run `slopweaver init`";
  }
  return Array.isArray(readJsonFile({ path }))
    ? "identity.json: present (valid)"
    : "identity.json: present (INVALID: not a JSON array)";
}

/**
 * Build the doctor report lines for a specific home. Does read-only fs probes against `home` (no writes),
 * so it is exercised by a fixture round-trip test without any mock.
 *
 * @param home the state home to report on
 * @param envHome the raw `$SLOPWEAVER_HOME` (for the "unset — using default" line), or undefined
 * @param version the plugin version string
 * @returns the report lines, in display order
 */
export function doctorReport({
  home,
  envHome,
  version,
}: {
  home: string;
  envHome: string | undefined;
  version: string;
}): readonly string[] {
  const paths = stateHomePaths({ home });
  const lines = [
    `slopweaver v${version}`,
    `SLOPWEAVER_HOME: ${envHome !== undefined && envHome.length > 0 ? envHome : `unset — using default ${paths.root}`}`,
    homeVersionLine({ path: paths.homeVersion }),
    `corpus: bronze ${dirStatus({ path: paths.corpus.bronze })} · silver ${dirStatus({ path: paths.corpus.silver })} · gold ${dirStatus({ path: paths.corpus.gold })}`,
    `beliefs: ${dirStatus({ path: paths.beliefs })}`,
    `ledgers: ${dirStatus({ path: paths.ledgers })}`,
    identityLine({ path: paths.identityJson }),
    profileLine({ path: paths.profileJson }),
    `hygiene-denylist.txt: ${existsSync(paths.hygieneDenylist) ? "present" : "missing (no private denylist)"}`,
  ];
  // A pre-rename home has an orphaned `warehouse/`; the medallion root is `corpus/` now. Heads-up, not a fault.
  if (existsSync(join(paths.root, "warehouse"))) {
    lines.push(
      "note: a legacy `warehouse/` dir is present — the corpus root is now `corpus/`; re-run refresh/derive/distil to repopulate it.",
    );
  }
  lines.push("ok");
  return lines;
}

/** The parse-only status of a JSON seed file — never its contents (present-valid / present-invalid / missing). */
function seedStatus({ path, valid }: { path: string; valid: (value: unknown) => boolean }): string {
  if (!existsSync(path)) {
    return "missing";
  }
  return valid(readJsonFile({ path })) ? "present-valid" : "present-invalid";
}

/**
 * The MACHINE-READABLE doctor report — a stable, value-free shape the `/slopweaver:onboard` slash command
 * branches on. It reports paths + presence/parse statuses ONLY: never a secret value, never identity or
 * profile CONTENTS (identity/profile carry only `present-valid`/`present-invalid`/`missing`). Read-only.
 *
 * @param home the state home to report on
 * @param envHome the raw `$SLOPWEAVER_HOME` (or undefined when unset)
 * @param version the plugin version string
 * @returns the structured report
 */
export function doctorJsonReport({
  home,
  envHome,
  version,
}: {
  home: string;
  envHome: string | undefined;
  version: string;
}): {
  readonly version: string;
  readonly home: string;
  readonly envHome: string | null;
  readonly initialised: boolean;
  readonly paths: Readonly<Record<string, string>>;
  readonly statuses: Readonly<Record<string, string>>;
} {
  const paths = stateHomePaths({ home });
  const homeVersion = readJsonFile({ path: paths.homeVersion });
  return {
    envHome: envHome !== undefined && envHome.length > 0 ? envHome : null,
    home,
    initialised: isRecord(homeVersion) && typeof homeVersion["version"] === "number",
    paths: {
      bronze: paths.corpus.bronze,
      gold: paths.corpus.gold,
      identity: paths.identityJson,
      members: paths.corpus.members,
      profile: paths.profileJson,
      root: paths.root,
      secrets: paths.secrets,
      silver: paths.corpus.silver,
      structures: paths.corpus.structures,
    },
    statuses: {
      bronze: dirStatus({ path: paths.corpus.bronze }),
      denylist: existsSync(paths.hygieneDenylist) ? "present" : "missing",
      gold: dirStatus({ path: paths.corpus.gold }),
      identity: seedStatus({ path: paths.identityJson, valid: (v) => Array.isArray(v) }),
      members: dirStatus({ path: paths.corpus.members }),
      profile: seedStatus({ path: paths.profileJson, valid: (v) => parseProfile({ value: v }).ok }),
      secrets: dirStatus({ path: paths.secrets }),
      silver: dirStatus({ path: paths.corpus.silver }),
      structures: dirStatus({ path: paths.corpus.structures }),
    },
    version,
  };
}

export function runDoctor(argv: readonly string[]): number {
  const rest = new Set(argv.slice(3));
  if (rest.has("--help") || rest.has("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const envHome = process.env["SLOPWEAVER_HOME"];
  const home = stateHomePaths().root;
  const version = pluginVersion();
  if (rest.has("--json")) {
    logger.out(JSON.stringify(doctorJsonReport({ envHome, home, version }), null, 2));
    return EXIT_OK;
  }
  for (const line of doctorReport({ envHome, home, version })) {
    logger.out(line);
  }
  return EXIT_OK;
}

export const doctorRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: true,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver doctor",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  run: runDoctor,
  summary: "Env preflight: plugin version + the resolved state home and its layout",
  usage: USAGE,
});
