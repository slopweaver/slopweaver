import { describe, expect, it } from "vitest";
import type { CommandMeta } from "../cli/defineCommand.js";
import { lazy } from "../cli/manifest.js";
import type { NounGroups } from "../cli/router.js";
import { analyzeCoverage, type SourceFile } from "./coverage.js";
import type { DoorEffect } from "./types.js";

/** A complete CommandMeta fixture varying only the door-relevant fields. */
function metaWith({ effect, doorRouted = false }: { effect: DoorEffect; doorRouted?: boolean }): CommandMeta {
  return {
    createsWorkItem: false,
    diagnostic: false,
    doorRouted,
    dryParseSafe: false,
    effect,
    example: null,
    parseRejectIsIoFree: false,
    requiresApproval: false,
    summary: "s",
    usage: "u",
  };
}

/** A registry with one fully-accounted verb (external-write + doorRouted). */
const routedGroups: NounGroups = {
  demo: {
    run: lazy({ load: () => Promise.resolve(() => 0), meta: metaWith({ doorRouted: true, effect: "external-write" }) }),
  },
};

const cleanFiles: readonly SourceFile[] = [
  { content: "writeFileSync(path, x)", path: "src/lib/jsonFile.ts" }, // sanctioned local-state
  { content: "const x = 1", path: "src/admit/door.ts" }, // no seam
];

describe("analyzeCoverage", () => {
  it("is ok when every seam is sanctioned and every verb accounts for its effect", () => {
    const report = analyzeCoverage({ files: cleanFiles, groups: routedGroups });
    expect(report.ok).toBe(true);
    expect(report.open).toEqual([]);
    expect(report.verbGaps).toEqual([]);
  });

  it("reports a direct write in an un-sanctioned file as an OPEN seam and fails", () => {
    const report = analyzeCoverage({
      files: [{ content: "writeFileSync(p, x)", path: "src/connectors/slack.ts" }],
      groups: routedGroups,
    });
    expect(report.ok).toBe(false);
    expect(report.open.map((s) => s.file)).toEqual(["src/connectors/slack.ts"]);
    expect(report.open[0]!.seam).toBe("writeFileSync");
  });

  it("classes a sanctioned file's seam by its declared class, not open", () => {
    const report = analyzeCoverage({
      files: [{ content: "spawn(cmd)", path: "src/llm/claudeCli.ts" }],
      groups: routedGroups,
    });
    expect(report.seams[0]!.seamClass).toBe("llm-transport");
    expect(report.open).toEqual([]);
  });

  it("fails when an external-write verb is not routed through the door", () => {
    const groups: NounGroups = {
      demo: { run: lazy({ load: () => Promise.resolve(() => 0), meta: metaWith({ effect: "external-write" }) }) },
    };
    const report = analyzeCoverage({ files: cleanFiles, groups });
    expect(report.verbGaps).toEqual([{ noun: "demo", reason: "external-write-not-routed", verb: "run" }]);
  });
});
