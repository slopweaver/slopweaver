import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unwrap, unwrapErr } from "../lib/result.js";
import { secretFilePath } from "../stateHome.js";
import { normaliseSecretInput, writeSecretFile } from "./store.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slop-secrets-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

describe("normaliseSecretInput", () => {
  it("strips a single trailing newline a shell pipe adds", () => {
    expect(unwrap(normaliseSecretInput({ input: "fake-token-abc-123\n" }))).toBe("fake-token-abc-123");
  });

  it("strips a trailing CRLF", () => {
    expect(unwrap(normaliseSecretInput({ input: "fake-token-abc-123\r\n" }))).toBe("fake-token-abc-123");
  });

  it("keeps an interior-dash token byte-for-byte (no interior trim)", () => {
    expect(unwrap(normaliseSecretInput({ input: "lin_api_AbC-dEf_123" }))).toBe("lin_api_AbC-dEf_123");
  });

  it("rejects an empty value", () => {
    expect(unwrapErr(normaliseSecretInput({ input: "\n" }))[0]).toContain("empty secret value");
  });

  it("rejects a multi-line value", () => {
    expect(unwrapErr(normaliseSecretInput({ input: "line1\nline2" }))[0]).toContain("multiple lines");
  });
});

describe("writeSecretFile", () => {
  it("writes the token to the named secret file at 0600", () => {
    const result = unwrap(writeSecretFile({ home, name: "slack-user-token", value: "fake-slack-value" }));
    expect(result.path).toBe(secretFilePath({ home, name: "slack-user-token" }));
    expect(result.written).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("fake-slack-value");
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it("is idempotent by content — the same value re-written keeps one file at 0600", () => {
    writeSecretFile({ home, name: "linear-token", value: "lin-1" });
    const second = unwrap(writeSecretFile({ home, name: "linear-token", value: "lin-1" }));
    expect(readFileSync(second.path, "utf8")).toBe("lin-1");
    expect(statSync(second.path).mode & 0o777).toBe(0o600);
  });

  it("overwrites a prior value and re-tightens the mode", () => {
    const path = secretFilePath({ home, name: "notion-token" });
    writeSecretFile({ home, name: "notion-token", value: "old" });
    writeSecretFile({ home, name: "notion-token", value: "new" });
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
