import { describe, expect, it } from "vitest";
import { renderConnectJson, renderConnectText } from "./render.js";
import type { ConnectCheckReport } from "./types.js";

const report: ConnectCheckReport = {
  capabilities: [
    { detail: "reached the org", id: "auth", status: "ok" },
    { detail: "teams unreadable — needs read:org", id: "scope:read:org", status: "missing" },
  ],
  errors: [],
  ok: false,
  source: "github",
  tokenPresent: true,
  warnings: [],
};

describe("renderConnectJson", () => {
  it("emits a stable, value-free shape the slash command branches on", () => {
    expect(JSON.parse(renderConnectJson({ report }))).toEqual({
      capabilities: [
        { detail: "reached the org", id: "auth", status: "ok" },
        { detail: "teams unreadable — needs read:org", id: "scope:read:org", status: "missing" },
      ],
      errors: [],
      ok: false,
      source: "github",
      tokenPresent: true,
      warnings: [],
    });
  });
});

describe("renderConnectText", () => {
  it("prints a headline verdict then one line per capability with its status mark", () => {
    const lines = renderConnectText({ report });
    expect(lines[0]).toBe("connect github: NOT READY");
    expect(lines[1]).toBe("  ✓ auth: reached the org");
    expect(lines[2]).toBe("  ✗ scope:read:org: teams unreadable — needs read:org");
  });

  it("headlines OK when the report is ready", () => {
    const ready: ConnectCheckReport = { ...report, capabilities: [], ok: true };
    expect(renderConnectText({ report: ready })[0]).toBe("connect github: OK");
  });
});
