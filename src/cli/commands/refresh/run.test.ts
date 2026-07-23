import { describe, expect, it } from "vitest";
import type { SourceIngestJob } from "../../../corpus/ingestSource.js";
import type { CorpusRecord, ExportWindow } from "../../../corpus/types.js";
import { ok } from "../../../lib/result.js";
import type { MemberHydrationResult } from "./members.js";
import { type RefreshDeps, runRefreshWithDeps } from "./run.js";

/** A no-op source job (its `run` is never reached — `ingestSources` is faked). */
function stubJob(source: CorpusRecord["source"], window: ExportWindow): SourceIngestJob {
  return { label: "stub", run: async () => ok({ records: [], warnings: [] }), source, window };
}

interface Captured {
  readonly deps: RefreshDeps;
  readonly hydrated: string[];
  readonly progress: { phase: string; label: string }[];
  readonly out: string[];
}

/** A full RefreshDeps fake (plain functions, no mocks). `withHydration` toggles the PR4.1 member seam. */
function fakeDeps({ withHydration }: { withHydration: boolean }): Captured {
  const hydrated: string[] = [];
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
  const deps: RefreshDeps = {
    buildGithubJob: ({ window }) => ok(stubJob("github", window)),
    buildSourceJob: ({ window }) => stubJob("slack", window),
    home: () => "/home",
    ingestSources: async () => ok([]),
    logger: { error: () => {}, info: () => {}, out: (m) => out.push(m), warn: () => {} },
    nowDate: () => new Date("2026-07-20T00:00:00.000Z"),
    onProgress: (p) => progress.push({ label: p.label, phase: p.phase }),
    readWatermark: () => undefined,
    resolveTokens: () => ({}),
    slackReadToken: () => ({}),
    ...(withHydration ? { hydrateMember: hydrate } : {}),
  };
  return { deps, hydrated, out, progress };
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
