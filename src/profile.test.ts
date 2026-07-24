import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unwrap, unwrapErr } from "./lib/result.js";
import { PROFILE_SCHEMA_VERSION, parseProfile } from "./profile.js";

const template: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../templates/profile.template.json", import.meta.url)), "utf8"),
);

describe("parseProfile", () => {
  it("accepts the shipped template", () => {
    const result = parseProfile({ value: template });
    expect(result.ok).toBe(true);
    const profile = unwrap(result);
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(profile.id).toBe("me");
    expect(profile.displayName).toBe("");
    expect(profile.gitNamespace).toBe("");
    expect(profile.sources).toEqual([]);
  });

  it("accepts a populated profile", () => {
    const result = parseProfile({
      value: { displayName: "Dev", gitNamespace: "octocat", id: "me", schemaVersion: 1, sources: ["github"] },
    });
    expect(result.ok).toBe(true);
    expect(unwrap(result).sources).toEqual(["github"]);
  });

  it("parses the optional owner-bot declaration, defaulting absent id lists to empty (PR4.5)", () => {
    const result = parseProfile({
      value: {
        displayName: "Dev",
        gitNamespace: "octocat",
        id: "me",
        schemaVersion: 1,
        slackBot: { botUserIds: ["U_OWNER_BOT"], ownerUserId: "U_OWNER" },
        sources: [],
      },
    });
    expect(unwrap(result).slackBot).toEqual({
      appIds: [],
      botIds: [],
      botUserIds: ["U_OWNER_BOT"],
      ownerUserId: "U_OWNER",
    });
  });

  it("leaves slackBot absent when not declared (me-to-me off)", () => {
    const result = parseProfile({
      value: { displayName: "", gitNamespace: "", id: "me", schemaVersion: 1, sources: [] },
    });
    expect(unwrap(result).slackBot).toBeUndefined();
  });

  it("rejects a slackBot without an ownerUserId", () => {
    const result = parseProfile({
      value: { displayName: "", gitNamespace: "", id: "me", schemaVersion: 1, slackBot: {}, sources: [] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    const result = parseProfile({
      value: { displayName: "", gitNamespace: "", id: "me", schemaVersion: 2, sources: [] },
    });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("schemaVersion must be 1");
  });

  it("rejects a non-string id", () => {
    const result = parseProfile({ value: { displayName: "", gitNamespace: "", id: 7, schemaVersion: 1, sources: [] } });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("id must be a string");
  });

  it("rejects non-array sources", () => {
    const result = parseProfile({
      value: { displayName: "", gitNamespace: "", id: "me", schemaVersion: 1, sources: "github" },
    });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("sources must be an array of strings");
  });

  it("rejects sources with a non-string element", () => {
    const result = parseProfile({
      value: { displayName: "", gitNamespace: "", id: "me", schemaVersion: 1, sources: ["github", 3] },
    });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("sources must be an array of strings");
  });

  it("rejects a non-object value", () => {
    const result = parseProfile({ value: "nope" });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result)).toEqual(["profile.json is not a JSON object"]);
  });
});
