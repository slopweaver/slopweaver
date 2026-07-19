import { describe, expect, it } from "vitest";
import { safeApiCall, safeEmbed, safeFs, safeFsAsync, safeLlm } from "./safeBoundary.js";

describe("safeApiCall", () => {
  it("returns the value on success", async () => {
    const result = await safeApiCall({ execute: async () => 42, operation: "slack.history", provider: "slack" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(42);
  });

  it("maps an async throw to a typed error, losing no status/code/cause detail", async () => {
    const thrown = Object.assign(new Error("rate limited"), { code: "ratelimited", status: 429 });
    const result = await safeApiCall({
      execute: async () => {
        throw thrown;
      },
      operation: "slack.conversations.history",
      provider: "slack",
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("rate-limit");
    expect(error.status).toBe(429);
    expect(error.code).toBe("ratelimited");
    expect(error.provider).toBe("slack");
    expect(error.operation).toBe("slack.conversations.history");
    expect(error.cause).toBe(thrown);
  });

  it("captures a SYNCHRONOUS throw from execute too (the Promise.resolve().then idiom)", async () => {
    const result = await safeApiCall({
      execute: () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
      operation: "linear.issues",
      provider: "linear",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("http");
    expect(result._unsafeUnwrapErr().status).toBe(500);
  });
});

describe("safeLlm / safeEmbed", () => {
  it("maps an LLM throw to a typed llm error with provider claude", async () => {
    const result = await safeLlm({
      execute: async () => {
        throw new Error("claude CLI timed out");
      },
      operation: "claude.complete",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("llm");
    expect(result._unsafeUnwrapErr().provider).toBe("claude");
  });

  it("maps an embed throw to a typed llm error with provider embed", async () => {
    const result = await safeEmbed({
      execute: async () => {
        throw new Error("embedder unavailable");
      },
      operation: "embed.embedDocuments",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().provider).toBe("embed");
  });
});

describe("safeFsAsync / safeFs", () => {
  it("maps an async fs throw to a typed io error carrying code and path", async () => {
    const result = await safeFsAsync({
      execute: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      operation: "appendVectorRows",
      path: "/tmp/vectors.jsonl",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("io");
    expect(result._unsafeUnwrapErr().code).toBe("ENOENT");
    expect(result._unsafeUnwrapErr().path).toBe("/tmp/vectors.jsonl");
  });

  it("returns the value from a synchronous fs call", () => {
    const result = safeFs({ execute: () => "contents", operation: "readFileSync" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("contents");
  });

  it("maps a synchronous fs throw to a typed io error", () => {
    const result = safeFs({
      execute: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      operation: "writeJsonFile",
      path: "/root/x.json",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("io");
    expect(result._unsafeUnwrapErr().path).toBe("/root/x.json");
  });
});
