import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import { advanceGithubRepoWatermarks, computeRepoWatermarks, readGithubRepoWatermarks } from "./repoWatermark.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "slopweaver-repowm-"));
}

describe("computeRepoWatermarks", () => {
  it("takes the max tsIso per repo and falls a seen-but-empty repo back to `until`", () => {
    const advances = computeRepoWatermarks({
      fallbackUntil: "2026-07-24",
      observed: [
        { repo: "acme/app", tsIso: "2026-07-01T00:00:00.000Z" },
        { repo: "acme/app", tsIso: "2026-07-10T00:00:00.000Z" },
        { repo: "acme/lib", tsIso: "" },
      ],
    });
    expect(advances).toEqual([
      { cursor: "2026-07-10T00:00:00.000Z", repo: "acme/app" },
      { cursor: "2026-07-24", repo: "acme/lib" },
    ]);
  });
});

describe("advanceGithubRepoWatermarks + readGithubRepoWatermarks", () => {
  it("persists per-repo cursors and MAX-merges on a re-advance (never backwards)", () => {
    const home = tempHome();
    unwrap(advanceGithubRepoWatermarks({ advances: [{ cursor: "2026-07-10", repo: "acme/app" }], home }));
    unwrap(
      advanceGithubRepoWatermarks({
        advances: [
          { cursor: "2026-07-05", repo: "acme/app" },
          { cursor: "2026-07-08", repo: "acme/lib" },
        ],
        home,
      }),
    );
    const map = readGithubRepoWatermarks({ home });
    expect(map.get("acme/app")).toBe("2026-07-10");
    expect(map.get("acme/lib")).toBe("2026-07-08");
  });

  it("reads an empty map when no file exists", () => {
    expect(readGithubRepoWatermarks({ home: tempHome() }).size).toBe(0);
  });
});
