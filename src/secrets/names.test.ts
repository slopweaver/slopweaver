import { describe, expect, it } from "vitest";
import { unwrap, unwrapErr } from "../lib/result.js";
import { parseSecretName, SECRET_NAMES } from "./names.js";

describe("parseSecretName", () => {
  it("accepts every allowlisted connector name", () => {
    for (const name of SECRET_NAMES) {
      expect(unwrap(parseSecretName({ value: name }))).toBe(name);
    }
  });

  it("trims surrounding whitespace before matching", () => {
    expect(unwrap(parseSecretName({ value: "  slack-user-token  " }))).toBe("slack-user-token");
  });

  it("rejects an unknown name with the accepted list", () => {
    expect(unwrapErr(parseSecretName({ value: "slack-token" }))[0]).toContain("unknown secret name: slack-token");
  });

  it("rejects a path-traversal name", () => {
    expect(unwrapErr(parseSecretName({ value: "../evil" }))[0]).toContain("no path separators");
  });

  it("rejects a name containing a slash", () => {
    expect(unwrapErr(parseSecretName({ value: "linear-token/x" }))[0]).toContain("no path separators");
  });
});
