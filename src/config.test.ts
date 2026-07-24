import { afterEach, describe, expect, it } from "vitest";
import { parseRepositorySlug, progressJsonEnabled, repositoryFromGitRemote } from "./config.js";
import { unwrap } from "./lib/result.js";

describe("progressJsonEnabled (env gate)", () => {
  const original = process.env["SLOPWEAVER_PROGRESS_JSON"];
  afterEach(() => {
    if (original === undefined) {
      delete process.env["SLOPWEAVER_PROGRESS_JSON"];
    } else {
      process.env["SLOPWEAVER_PROGRESS_JSON"] = original;
    }
  });

  it("is OFF unless the env var is set to a non-empty value", () => {
    delete process.env["SLOPWEAVER_PROGRESS_JSON"];
    expect(progressJsonEnabled()).toBe(false);
    process.env["SLOPWEAVER_PROGRESS_JSON"] = "";
    expect(progressJsonEnabled()).toBe(false);
    process.env["SLOPWEAVER_PROGRESS_JSON"] = "1";
    expect(progressJsonEnabled()).toBe(true);
  });
});

describe("repositoryFromGitRemote", () => {
  it.each([
    ["https://github.com/octocat/Hello-World.git"],
    ["https://github.com/octocat/Hello-World"],
    ["git@github.com:octocat/Hello-World.git"],
    ["ssh://git@github.com/octocat/Hello-World.git"],
  ])("parses %s", (url) => {
    const result = repositoryFromGitRemote({ remoteUrl: url });
    expect(result.ok).toBe(true);
    expect(unwrap(result)).toEqual({ owner: "octocat", repo: "Hello-World" });
  });

  it("handles an SSH host alias (per-account clone)", () => {
    const result = repositoryFromGitRemote({ remoteUrl: "git@github-personal:slopweaver/slopweaver.git" });
    expect(unwrap(result)).toEqual({ owner: "slopweaver", repo: "slopweaver" });
  });

  it("rejects an unparseable remote", () => {
    expect(repositoryFromGitRemote({ remoteUrl: "not-a-remote" }).ok).toBe(false);
  });
});

describe("parseRepositorySlug", () => {
  it("accepts owner/repo", () => {
    const result = parseRepositorySlug({ slug: "a/b" });
    expect(unwrap(result)).toEqual({ owner: "a", repo: "b" });
  });

  it.each(["abc", "a/b/c", "/x", "x/"])("rejects %s", (slug) => {
    expect(parseRepositorySlug({ slug }).ok).toBe(false);
  });
});
