import { describe, expect, it } from "vitest";
import { unwrap } from "../lib/result.js";
import { parseCorpusRecords } from "./corpusStore.js";

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    container: "o/r",
    kind: "pr",
    refs: [],
    source: "github",
    sourceId: "#1",
    text: "hi",
    tsIso: "2024-01-01T00:00:00Z",
    url: "u",
    ...over,
  });

describe("parseCorpusRecords", () => {
  it("keeps valid records and skips corrupt/unknown lines with warnings", () => {
    const content = [
      line(),
      "not json at all",
      line({ source: "gitlab" }), // unknown source (github/slack/linear/notion/gold only)
      line({ text: "" }), // missing required field
      "",
    ].join("\n");
    const result = parseCorpusRecords({ content });
    expect(unwrap(result)).toHaveLength(1);
    expect(result.warnings).toHaveLength(3);
  });

  it("drops a record with an unknown kind", () => {
    const result = parseCorpusRecords({ content: line({ kind: "saga" }) });
    expect(unwrap(result)).toHaveLength(0);
    expect(result.warnings[0]).toContain("unknown kind");
  });
});
