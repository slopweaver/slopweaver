/**
 * Tolerant reader for the silver index — the directory + opportunities JSON that derive wrote. distil's
 * gold reduce reads these back (rather than recomputing the graph over the whole corpus). Anything
 * missing or garbled degrades to empty, so gold still builds (just thinner).
 */
import { join } from "node:path";
import { silverIndexDir } from "../corpus/corpusPaths.js";
import { readJsonFile } from "../lib/jsonFile.js";
import { isRecord } from "../lib/parsers.js";
import type { DirectoryEntry } from "./directory.js";
import type { Opportunity } from "./opportunity.js";

export interface SilverIndex {
  readonly people: readonly DirectoryEntry[];
  readonly containers: readonly DirectoryEntry[];
  readonly opportunities: readonly Opportunity[];
}

function asArray({ value }: { value: unknown }): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function directoryEntries({ value }: { value: unknown }): readonly DirectoryEntry[] {
  return asArray({ value }).flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      (entry["kind"] !== "person" && entry["kind"] !== "container")
    ) {
      return [];
    }
    const sources = asArray({ value: entry["sources"] }).filter((s): s is string => typeof s === "string");
    return [
      {
        id: entry["id"],
        kind: entry["kind"],
        recordCount: typeof entry["recordCount"] === "number" ? entry["recordCount"] : 0,
        sources: sources as DirectoryEntry["sources"],
      },
    ];
  });
}

function opportunities({ value }: { value: unknown }): readonly Opportunity[] {
  return asArray({ value }).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["subject"] !== "string" || typeof entry["summary"] !== "string") {
      return [];
    }
    if (entry["kind"] !== "cross-cutting" && entry["kind"] !== "blocker" && entry["kind"] !== "duplication") {
      return [];
    }
    return [
      {
        evidence: asArray({ value: entry["evidence"] }).filter((e): e is string => typeof e === "string"),
        kind: entry["kind"],
        score: typeof entry["score"] === "number" ? entry["score"] : 0,
        subject: entry["subject"],
        summary: entry["summary"],
      },
    ];
  });
}

/**
 * Read the silver index (directory + opportunities) written by derive.
 *
 * @param home the world-model home (defaults to the resolved home)
 * @returns people, containers, and opportunities (empty where absent/garbled)
 */
export function readSilverIndex({ home }: { home?: string } = {}): SilverIndex {
  const dir = silverIndexDir(home === undefined ? {} : { home });
  const directory = readJsonFile({ path: join(dir, "directory.json") });
  const opps = readJsonFile({ path: join(dir, "opportunities.json") });
  const dirObj = isRecord(directory) ? directory : {};
  return {
    containers: directoryEntries({ value: dirObj["containers"] }),
    opportunities: opportunities({ value: opps }),
    people: directoryEntries({ value: dirObj["people"] }),
  };
}
