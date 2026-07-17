import { describe, expect, it } from "vitest";

import { STATE_HOME_VERSION, stateHomePaths } from "./stateHome.js";

describe("stateHomePaths", () => {
  const home = "/tmp/sw-home";

  it("pins every sub-path exactly under the given home", () => {
    const p = stateHomePaths({ home });
    expect(p.root).toBe("/tmp/sw-home");
    expect(p.homeVersion).toBe("/tmp/sw-home/.home-version.json");
    expect(p.corpus.root).toBe("/tmp/sw-home/corpus");
    expect(p.corpus.bronze).toBe("/tmp/sw-home/corpus/bronze");
    expect(p.corpus.silver).toBe("/tmp/sw-home/corpus/silver");
    expect(p.corpus.gold).toBe("/tmp/sw-home/corpus/gold");
    expect(p.corpus.cache).toBe("/tmp/sw-home/corpus/.cache");
    expect(p.corpus.watermark).toBe("/tmp/sw-home/corpus/.watermark.json");
    expect(p.beliefs).toBe("/tmp/sw-home/beliefs");
    expect(p.ledgers).toBe("/tmp/sw-home/ledgers");
    expect(p.identityJson).toBe("/tmp/sw-home/identity.json");
    expect(p.profileJson).toBe("/tmp/sw-home/profile.json");
    expect(p.hygieneDenylist).toBe("/tmp/sw-home/hygiene-denylist.txt");
    expect(p.modelCache).toBe("/tmp/sw-home/.cache/models");
  });

  it("keeps bronze/silver/gold under the corpus root (the post-rename medallion layout)", () => {
    const p = stateHomePaths({ home });
    expect(p.corpus.bronze.startsWith(`${p.corpus.root}/`)).toBe(true);
    expect(p.corpus.silver.startsWith(`${p.corpus.root}/`)).toBe(true);
    expect(p.corpus.gold.startsWith(`${p.corpus.root}/`)).toBe(true);
  });

  it("normalises sub-paths under a trailing-slash home (no doubled separator)", () => {
    const p = stateHomePaths({ home: "/tmp/sw-home/" });
    expect(p.corpus.bronze).toBe("/tmp/sw-home/corpus/bronze");
    expect(p.identityJson).toBe("/tmp/sw-home/identity.json");
    expect(p.modelCache).toBe("/tmp/sw-home/.cache/models");
  });

  it("exposes a numeric layout version", () => {
    expect(STATE_HOME_VERSION).toBe(1);
  });
});
