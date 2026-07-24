import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadProfile } from "./profileStore.js";

/** Write a `profile.json` into a fresh temp home and return the home dir. */
function seedProfile({ content }: { content: string }): string {
  const home = mkdtempSync(join(tmpdir(), "slopweaver-profile-"));
  writeFileSync(join(home, "profile.json"), content, "utf8");
  return home;
}

describe("loadProfile", () => {
  it("reads a valid profile back, including the owner-bot declaration", () => {
    const home = seedProfile({
      content: JSON.stringify({
        displayName: "Ada Owner",
        gitNamespace: "ada-gh",
        id: "owner-1",
        schemaVersion: 1,
        slackBot: { botUserIds: ["U_OWNER_BOT"], ownerUserId: "U_OWNER" },
        sources: ["github"],
      }),
    });
    const profile = loadProfile({ home });
    expect(profile!.id).toBe("owner-1");
    expect(profile!.slackBot).toEqual({ appIds: [], botIds: [], botUserIds: ["U_OWNER_BOT"], ownerUserId: "U_OWNER" });
  });

  it("returns undefined when no profile file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "slopweaver-profile-none-"));
    expect(loadProfile({ home })).toBeUndefined();
  });

  it("returns undefined for a corrupt (non-JSON) profile", () => {
    const home = seedProfile({ content: "{ not json" });
    expect(loadProfile({ home })).toBeUndefined();
  });

  it("returns undefined for a schema-invalid profile", () => {
    const home = seedProfile({ content: JSON.stringify({ id: "owner-1", schemaVersion: 99 }) });
    expect(loadProfile({ home })).toBeUndefined();
  });
});
