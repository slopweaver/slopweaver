import { describe, expect, it } from "vitest";
import type { SourceIngestJob } from "../../../corpus/ingestSource.js";
import type { CorpusRecord, ExportWindow } from "../../../corpus/types.js";
import { ok } from "../../../lib/result.js";
import type { MemberHydrationResult } from "./members.js";
import { type RefreshDeps, runRefreshWithDeps } from "./run.js";
import type { StructureHydrationResult } from "./structures.js";

/** A no-op source job (its `run` is never reached — `ingestSources` is faked). */
function stubJob(source: CorpusRecord["source"], window: ExportWindow): SourceIngestJob {
  return { label: "stub", run: async () => ok({ records: [], warnings: [] }), source, window };
}

interface Captured {
  readonly deps: RefreshDeps;
  readonly hydrated: string[];
  readonly structured: string[];
  readonly builtJobs: string[];
  readonly progress: { phase: string; label: string }[];
  readonly out: string[];
}

/** A full RefreshDeps fake (plain functions, no mocks). `withHydration` toggles the PR4.1/4.2 seams. */
function fakeDeps({ withHydration }: { withHydration: boolean }): Captured {
  const hydrated: string[] = [];
  const structured: string[] = [];
  const builtJobs: string[] = [];
  const progress: { phase: string; label: string }[] = [];
  const out: string[] = [];
  const hydrate = async ({
    source,
  }: {
    source: CorpusRecord["source"];
  }): Promise<MemberHydrationResult | undefined> => {
    if (source === "gold") {
      return undefined; // mirrors production: the synthetic source is never hydrated
    }
    hydrated.push(source);
    return { deduped: 0, errors: [], hydrated: 5, ok: true, source, warnings: [], written: 5 };
  };
  const hydrateStructure = async ({
    source,
  }: {
    source: CorpusRecord["source"];
  }): Promise<StructureHydrationResult | undefined> => {
    if (source === "gold") {
      return undefined;
    }
    structured.push(source);
    return { deduped: 0, errors: [], hydrated: 3, ok: true, source, warnings: [], written: 3 };
  };
  const deps: RefreshDeps = {
    buildGithubJob: ({ window }) => {
      builtJobs.push("single-repo");
      return ok(stubJob("github", window));
    },
    buildGithubOrgJob: ({ window }) => {
      builtJobs.push("org");
      return ok(stubJob("github", window));
    },
    buildSourceJob: ({ window }) => stubJob("slack", window),
    home: () => "/home",
    ingestSources: async () => ok([]),
    logger: { error: () => {}, info: () => {}, out: (m) => out.push(m), warn: () => {} },
    nowDate: () => new Date("2026-07-20T00:00:00.000Z"),
    onProgress: (p) => progress.push({ label: p.label, phase: p.phase }),
    readWatermark: () => undefined,
    resolveTokens: () => ({}),
    slackReadToken: () => ({}),
    ...(withHydration ? { hydrateMember: hydrate, hydrateStructure } : {}),
  };
  return { builtJobs, deps, hydrated, out, progress, structured };
}

const argv = (tail: readonly string[]): readonly string[] => ["node", "cli", "refresh", ...tail];

describe("runRefreshWithDeps — member hydration step (PR4.1)", () => {
  it("hydrates each selected source, emits non-blocking members:<source> progress, and folds the summary in", async () => {
    const cap = fakeDeps({ withHydration: true });
    await runRefreshWithDeps({ argv: argv(["--source", "github"]), deps: cap.deps });
    expect(cap.hydrated).toEqual(["github"]);
    expect(cap.progress.filter((p) => p.phase === "members").map((p) => p.label)).toEqual(["github", "github"]);
    expect(cap.out).toContain("members github: hydrated 5 (wrote 5 new, deduped 0)");
  });

  it("is a clean no-op when the member seam is absent (pre-PR4.1 back-compat)", async () => {
    const cap = fakeDeps({ withHydration: false });
    await runRefreshWithDeps({ argv: argv(["--source", "github"]), deps: cap.deps });
    expect(cap.progress.some((p) => p.phase === "members")).toBe(false);
    expect(cap.out.some((line) => line.startsWith("members "))).toBe(false);
  });
});

describe("runRefreshWithDeps — GitHub job routing (PR4.2 org mode)", () => {
  it("builds the SINGLE-REPO job by default (no org fan-out)", async () => {
    const cap = fakeDeps({ withHydration: false });
    await runRefreshWithDeps({ argv: argv(["--source", "github"]), deps: cap.deps });
    expect(cap.builtJobs).toEqual(["single-repo"]);
  });

  it("builds the ORG-MODE job when --all-repos is set", async () => {
    const cap = fakeDeps({ withHydration: false });
    await runRefreshWithDeps({
      argv: argv(["--source", "github", "--all-repos", "--github-org", "acme"]),
      deps: cap.deps,
    });
    expect(cap.builtJobs).toEqual(["org"]);
  });
});

describe("runRefreshWithDeps — structural hydration step (PR4.2)", () => {
  it("hydrates each selected source's structure + emits structures:<source> progress", async () => {
    const cap = fakeDeps({ withHydration: true });
    await runRefreshWithDeps({ argv: argv(["--source", "github"]), deps: cap.deps });
    expect(cap.structured).toEqual(["github"]);
    expect(cap.progress.filter((p) => p.phase === "structures").map((p) => p.label)).toEqual(["github", "github"]);
    expect(cap.out).toContain("structures github: hydrated 3 (wrote 3 new, deduped 0)");
  });

  it("is a clean no-op when the structure seam is absent (back-compat)", async () => {
    const cap = fakeDeps({ withHydration: false });
    await runRefreshWithDeps({ argv: argv(["--source", "github"]), deps: cap.deps });
    expect(cap.progress.some((p) => p.phase === "structures")).toBe(false);
  });
});
