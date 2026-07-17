/**
 * Render gold markdown from the silver index (directory + opportunities) and the distilled per-source
 * digests. Pure — the caller supplies `builtAtIso` so there's no clock here (deterministic, testable).
 * Three docs: an `overview`, one `by-source/<source>` per source, and a `where-to-look` pointer map.
 */
import type { DirectoryEntry } from "../silver/directory.js";
import type { Opportunity } from "../silver/opportunity.js";
import type { BatchDigest, SourceDigest } from "./distil.js";

export interface GoldDoc {
  /** Path relative to the gold dir, e.g. `overview.md` or `by-source/github.md`. */
  readonly path: string;
  readonly markdown: string;
}

export interface GoldInput {
  readonly people: readonly DirectoryEntry[];
  readonly containers: readonly DirectoryEntry[];
  readonly sources: readonly SourceDigest[];
  readonly opportunities: readonly Opportunity[];
  readonly builtAtIso: string;
}

function crossCutting({ opportunities }: { opportunities: readonly Opportunity[] }): readonly Opportunity[] {
  return opportunities.filter((o) => o.kind === "cross-cutting");
}

function bullet({ entry }: { entry: DirectoryEntry }): string {
  return `- \`${entry.id}\` — ${String(entry.recordCount)} records (${entry.sources.join(", ")})`;
}

function containerDigestBlock({ digest }: { digest: BatchDigest }): string {
  const lines = [`## ${digest.container}`, "", digest.summary, ""];
  for (const point of digest.points) {
    lines.push(`- ${point.point}`);
    lines.push(`  ↳ ${point.citations.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function overviewDoc({ people, containers, sources, opportunities, builtAtIso }: GoldInput): GoldDoc {
  const totalRecords = sources.reduce((sum, s) => sum + s.recordCount, 0);
  const lines = [
    "# World model — overview",
    "",
    `_built ${builtAtIso}_`,
    "",
    `Corpus: ${String(totalRecords)} records across ${String(sources.length)} source(s).`,
    "",
    "## By source",
    "",
    ...sources.map(
      (s) => `- **${s.source}** — ${String(s.recordCount)} records, ${String(s.containers.length)} containers`,
    ),
    "",
    "## Busiest containers",
    "",
    ...containers.slice(0, 15).map((entry) => bullet({ entry })),
    "",
    "## Most active people",
    "",
    ...people.slice(0, 15).map((entry) => bullet({ entry })),
    "",
    "## Cross-cutting concerns",
    "",
    ...crossCutting({ opportunities })
      .slice(0, 12)
      .map((o) => `- ${o.summary} _(score ${String(o.score)})_`),
    "",
  ];
  return { markdown: lines.join("\n"), path: "overview.md" };
}

function bySourceDoc({ digest }: { digest: SourceDigest }): GoldDoc {
  const lines = [
    `# ${digest.source}`,
    "",
    `${String(digest.recordCount)} records across ${String(digest.containers.length)} containers.`,
    "",
    ...digest.containers.map((container) => containerDigestBlock({ digest: container })),
  ];
  return { markdown: lines.join("\n"), path: `by-source/${digest.source}.md` };
}

function whereToLookDoc({ people, sources, opportunities }: GoldInput): GoldDoc {
  const lines = ["# Where to look", "", "## By source", ""];
  for (const source of sources) {
    lines.push(`### ${source.source}`);
    for (const container of source.containers.slice(0, 5)) {
      lines.push(`- \`${container.container}\` — ${container.summary}`);
    }
    lines.push("");
  }
  lines.push("## Owners", "");
  for (const person of people.slice(0, 12)) {
    lines.push(bullet({ entry: person }));
  }
  lines.push("", "## Cross-cutting threads", "");
  for (const opportunity of crossCutting({ opportunities }).slice(0, 8)) {
    lines.push(`- ${opportunity.summary}`);
  }
  lines.push("");
  return { markdown: lines.join("\n"), path: "where-to-look.md" };
}

/**
 * Build the gold markdown docs.
 *
 * @param input the silver directory + opportunities + per-source digests + build timestamp
 * @returns the gold docs (overview, one per source, where-to-look)
 */
export function buildGoldDocs(input: GoldInput): readonly GoldDoc[] {
  return [overviewDoc(input), ...input.sources.map((digest) => bySourceDoc({ digest })), whereToLookDoc(input)];
}
