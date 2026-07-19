/**
 * The coverage guarantee — proof that no side-effect seam escapes the door. It scans the source for
 * direct side-effecting primitives (fs writes/deletes, `spawn`/`execFileSync`) and checks the verb
 * registry, then classes every seam:
 *   - sanctioned seams (local-state writers under $SLOPWEAVER_HOME, the `claude` LLM transport, read-only
 *     git/gh callers, the door's own ledger + hook) are ACKNOWLEDGED — the product working normally;
 *   - any OTHER direct seam is `open` — a potential un-routed bypass — and FAILS the check;
 *   - a verb marked `external-write` that is not `doorRouted`, or a verb with no `effect` at all, FAILS too.
 *
 * PR2 has no external-write verbs (slopweaver is read-only), so the honest state is "100% accounted": every
 * current seam is sanctioned. The value is the RATCHET — when PR3+ adds a connector that shells a raw tool
 * or writes an outbound artifact without routing it, this turns red. Pure `analyzeCoverage`; effectful reader.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { isManifestEntry } from "../cli/manifest.js";
import { NOUN_GROUPS } from "../cli/nounGroups.js";
import type { NounGroups } from "../cli/router.js";

/** How a direct seam is accounted for. Anything not sanctioned is `open` (a failing finding). */
export type SeamClass = "door-internal" | "local-state" | "llm-transport" | "read-only-tool" | "dev-tooling" | "open";

/** The sanctioned direct-seam files, repo-relative → why they're allowed. A new seam OUTSIDE this list fails. */
export const SANCTIONED_SEAMS: Readonly<Record<string, Exclude<SeamClass, "open">>> = {
  "eval/askProvider.ts": "dev-tooling",
  "eval/scoreboardRun.ts": "dev-tooling",
  "hooks/pretooluse-admit.ts": "door-internal",
  "src/admit/ledger.ts": "door-internal",
  "src/cli/commands/distil/run.ts": "local-state",
  "src/config.ts": "read-only-tool",
  "src/corpus/corpusStore.ts": "local-state",
  "src/corpus/corpusWriter.ts": "local-state",
  "src/corpus/slack/threadCursors.ts": "local-state",
  "src/corpus/watermark.ts": "local-state",
  "src/devGate/devGate.ts": "local-state",
  "src/devLint/boundaryResidue.ts": "read-only-tool",
  "src/devLint/devLint.ts": "dev-tooling",
  "src/devLint/maxFunctionLines.ts": "read-only-tool",
  "src/devLint/resilienceResidue.ts": "read-only-tool",
  "src/eval/rebaselineCore.ts": "local-state",
  "src/gold/distilCache.ts": "local-state",
  "src/hygiene/scan.ts": "read-only-tool",
  "src/init/stateInit.ts": "local-state",
  "src/lib/jsonFile.ts": "local-state",
  "src/llm/claudeCli.ts": "llm-transport",
  "src/retrieval/vectorCacheStore.ts": "local-state",
};

/** Direct side-effecting primitives the scan looks for (as a call — `name(`), so imports don't match. */
const SEAM_PATTERNS: readonly { readonly seam: string; readonly re: RegExp }[] = [
  { re: /\bwriteFileSync\s*\(/, seam: "writeFileSync" },
  { re: /\bappendFileSync\s*\(/, seam: "appendFileSync" },
  { re: /\bmkdirSync\s*\(/, seam: "mkdirSync" },
  { re: /\brmSync\s*\(/, seam: "rmSync" },
  { re: /\bunlinkSync\s*\(/, seam: "unlinkSync" },
  { re: /\brenameSync\s*\(/, seam: "renameSync" },
  { re: /\bspawn(?:Sync)?\s*\(/, seam: "spawn" },
  { re: /\bexecFile(?:Sync)?\s*\(/, seam: "execFile" },
  { re: /\bexecSync\s*\(/, seam: "exec" },
];

/** One direct seam found in the source. */
export interface SeamHit {
  readonly file: string;
  readonly line: number;
  readonly seam: string;
  readonly seamClass: SeamClass;
}

/** A verb the registry could not account for: an external-write that isn't routed through the door. (Every
 * verb declaring an `effect` is now enforced at the type level by CommandMeta, so "missing effect" can't occur.) */
export interface VerbGap {
  readonly noun: string;
  readonly verb: string;
  readonly reason: "external-write-not-routed";
}

/** The whole picture: every seam (classed), the failing seams + verb gaps, and the verdict. */
export interface CoverageReport {
  readonly seams: readonly SeamHit[];
  readonly open: readonly SeamHit[];
  readonly verbGaps: readonly VerbGap[];
  readonly ok: boolean;
}

/** A source file to scan. */
export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

/** Class a file's seams: its sanctioned class, or `open` when the file isn't on the allowlist. */
function classifyFile({ path }: { path: string }): SeamClass {
  return SANCTIONED_SEAMS[path] ?? "open";
}

/** Every verb's registry entry that fails to account for a side effect (missing effect / unrouted write). */
function verbGaps({ groups }: { groups: NounGroups }): readonly VerbGap[] {
  const gaps: VerbGap[] = [];
  for (const noun of Object.keys(groups)) {
    const verbs = groups[noun] ?? {};
    for (const verb of Object.keys(verbs)) {
      if (verb === "") {
        continue; // the default-verb alias points at a named verb; it's counted there.
      }
      const entry = verbs[verb];
      if (entry === undefined || !isManifestEntry(entry)) {
        continue;
      }
      const { effect, doorRouted } = entry.meta;
      if (effect === "external-write" && doorRouted !== true) {
        gaps.push({ noun, reason: "external-write-not-routed", verb });
      }
    }
  }
  return gaps;
}

/**
 * Analyse coverage over a set of source files + the verb registry. Pure. `ok` is true only when every
 * direct seam is sanctioned AND every verb accounts for its effect.
 *
 * @param files the source files to scan (non-test)
 * @param groups the verb registry
 * @returns the coverage report
 */
export function analyzeCoverage({
  files,
  groups,
}: {
  files: readonly SourceFile[];
  groups: NounGroups;
}): CoverageReport {
  const seams: SeamHit[] = [];
  for (const file of files) {
    const seamClass = classifyFile({ path: file.path });
    file.content.split("\n").forEach((line, index) => {
      for (const { seam, re } of SEAM_PATTERNS) {
        if (re.test(line)) {
          seams.push({ file: file.path, line: index + 1, seam, seamClass });
        }
      }
    });
  }
  const open = seams.filter((s) => s.seamClass === "open");
  const gaps = verbGaps({ groups });
  return { ok: open.length === 0 && gaps.length === 0, open, seams, verbGaps: gaps };
}

/** The repo root, anchored on this module's location. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Recursively collect non-test `.ts` files under a dir (repo-relative paths), skipping node_modules. */
function collectSources({ root, dir }: { root: string; dir: string }): SourceFile[] {
  const out: SourceFile[] = [];
  let entries: readonly { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        out.push(...collectSources({ dir: full, root }));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push({ content: readFileSync(full, "utf8"), path: relative(root, full) });
    }
  }
  return out;
}

/**
 * Read the real source tree (src/ + eval/ + hooks/) and analyse coverage against the live registry.
 * Effectful edge over {@link analyzeCoverage}.
 *
 * @returns the coverage report for this repo
 */
export function coverageReport(): CoverageReport {
  const root = repoRoot();
  const files = [
    ...collectSources({ dir: join(root, "src"), root }),
    ...collectSources({ dir: join(root, "eval"), root }),
    ...collectSources({ dir: join(root, "hooks"), root }),
  ];
  return analyzeCoverage({ files, groups: NOUN_GROUPS });
}
