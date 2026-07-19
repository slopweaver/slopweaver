import { describe, expect, it } from "vitest";
import {
  errorCode,
  errorStatus,
  formatIngestError,
  hasTransientStatus,
  type IngestError,
  ingestErrorToThrowable,
  legacyErrorMessages,
  toIngestError,
} from "./ingestError.js";

describe("toIngestError", () => {
  it("maps a 429 to a rate-limit error, preserving status/code/retry-after and cause identity", () => {
    const thrown = Object.assign(new Error("rate limited"), { code: "ratelimited", retryAfter: 3, status: 429 });
    const mapped = toIngestError({ error: thrown, operation: "slack.conversations.history", provider: "slack" });
    expect(mapped.kind).toBe("rate-limit");
    expect(mapped.status).toBe(429);
    expect(mapped.code).toBe("ratelimited");
    expect(mapped.retryAfterMs).toBe(3000);
    expect(mapped.message).toBe("rate limited");
    expect(mapped.operation).toBe("slack.conversations.history");
    expect(mapped.provider).toBe("slack");
    expect(mapped.cause).toBe(thrown); // identity preserved
  });

  it("maps a 500 to an http error", () => {
    const mapped = toIngestError({
      error: Object.assign(new Error("boom"), { status: 500 }),
      operation: "linear.issues",
      provider: "linear",
    });
    expect(mapped.kind).toBe("http");
    expect(mapped.status).toBe(500);
    expect(mapped.provider).toBe("linear");
  });

  it("maps a bare 4xx to an http error (not transient)", () => {
    const mapped = toIngestError({ error: { status: 404 }, operation: "notion.pages", provider: "notion" });
    expect(mapped.kind).toBe("http");
    expect(mapped.status).toBe(404);
  });

  it("maps a network ECONNRESET (no status) to a network error", () => {
    const mapped = toIngestError({
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      operation: "slack.auth.test",
      provider: "slack",
    });
    expect(mapped.kind).toBe("network");
    expect(mapped.code).toBe("ECONNRESET");
    expect(mapped.status).toBeUndefined();
  });

  it("maps a `fetch failed` message to a network error", () => {
    const mapped = toIngestError({
      error: new Error("fetch failed"),
      operation: "linear.projects",
      provider: "linear",
    });
    expect(mapped.kind).toBe("network");
  });

  it("maps a JSON SyntaxError to a parse error under the parse default kind", () => {
    const thrown = new SyntaxError("Unexpected token < in JSON at position 0");
    const mapped = toIngestError({ defaultKind: "parse", error: thrown, operation: "envelopeToMessage" });
    expect(mapped.kind).toBe("parse");
    expect(mapped.message).toBe("Unexpected token < in JSON at position 0");
    expect(mapped.provider).toBeUndefined();
    expect(mapped.cause).toBe(thrown);
  });

  it("maps an ENOENT to an io error carrying the code and path", () => {
    const thrown = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const mapped = toIngestError({ defaultKind: "io", error: thrown, operation: "readJsonFile", path: "/tmp/x.json" });
    expect(mapped.kind).toBe("io");
    expect(mapped.code).toBe("ENOENT");
    expect(mapped.path).toBe("/tmp/x.json");
  });

  it("maps a `claude` timeout to an llm error", () => {
    const mapped = toIngestError({
      defaultKind: "llm",
      error: new Error("claude CLI timed out"),
      operation: "claude.complete",
      provider: "claude",
    });
    expect(mapped.kind).toBe("llm");
    expect(mapped.provider).toBe("claude");
    expect(mapped.status).toBeUndefined();
  });

  it("falls back to a readable message for a non-Error thrown value", () => {
    expect(toIngestError({ error: "raw string failure", operation: "x" }).message).toBe("raw string failure");
    expect(toIngestError({ error: undefined, operation: "x" }).message).toBe("unknown error");
  });
});

describe("accessors + formatting", () => {
  const error: IngestError = {
    cause: new Error("boom"),
    code: "ratelimited",
    kind: "rate-limit",
    message: "rate limited",
    operation: "slack.conversations.history",
    provider: "slack",
    status: 429,
  };

  it("reads status and code off the typed error", () => {
    expect(errorStatus({ error })).toBe(429);
    expect(errorCode({ error })).toBe("ratelimited");
  });

  it("classifies a transient status", () => {
    expect(hasTransientStatus({ error })).toBe(true);
    expect(hasTransientStatus({ error: { ...error, kind: "http", status: 404 } })).toBe(false);
    expect(hasTransientStatus({ error: { kind: "io", message: "m", operation: "o" } })).toBe(false);
  });

  it("formats a typed error into a single labelled line", () => {
    expect(formatIngestError({ error })).toBe("slack slack.conversations.history HTTP 429: rate limited");
  });

  it("formats an error without provider/status using the kind and no status segment", () => {
    expect(formatIngestError({ error: { kind: "parse", message: "bad json", operation: "parseEnvelope" } })).toBe(
      "parse parseEnvelope: bad json",
    );
  });

  it("bridges a typed error into the legacy string-array shape", () => {
    expect(legacyErrorMessages({ error })).toEqual(["slack slack.conversations.history HTTP 429: rate limited"]);
  });
});

describe("ingestErrorToThrowable", () => {
  it("returns the original cause verbatim when it is already an Error", () => {
    const cause = new Error("socket hang up");
    const typed = toIngestError({ error: cause, operation: "slack.auth.test", provider: "slack" });
    expect(ingestErrorToThrowable({ error: typed })).toBe(cause); // identity — message assertions stay exact
  });

  it("synthesises an Error carrying status/code when the cause is a non-Error throw", () => {
    // A plain object throw (no Error prototype) still carries a retryable 429 signal.
    const typed = toIngestError({ error: { code: "ratelimited", status: 429 }, operation: "linear.rawRequest" });
    const thrown = ingestErrorToThrowable({ error: typed });
    // The re-mapped throwable must still classify as a transient rate-limit (status/code survived the round-trip).
    const remapped = toIngestError({ error: thrown, operation: "retry" });
    expect(remapped.kind).toBe("rate-limit");
    expect(remapped.status).toBe(429);
    expect(remapped.code).toBe("ratelimited");
  });
});
