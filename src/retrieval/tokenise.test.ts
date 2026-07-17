import { describe, expect, it } from "vitest";
import { tokenise } from "./tokenise.js";

describe("tokenise", () => {
  it("lowercases, drops short tokens + stopwords, keeps repeats", () => {
    expect(tokenise({ text: "The auth flow AND the auth token" })).toEqual(["auth", "flow", "auth", "token"]);
  });

  it("appends whole entity-id tokens in addition to split parts", () => {
    expect(tokenise({ text: "see CLI-2727 now" })).toEqual(["see", "cli", "2727", "now", "cli-2727"]);
  });

  it("captures #-number references", () => {
    expect(tokenise({ text: "fixes #42" })).toContain("#42");
  });
});
