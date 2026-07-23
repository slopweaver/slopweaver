import { describe, expect, it } from "vitest";
import { issueAttachmentRefs, issueEdgeRefs } from "./curated.js";

describe("issueEdgeRefs", () => {
  it("emits sub-issue edges from children", () => {
    const node = { children: { nodes: [{ identifier: "TEAM-2" }, { identifier: "TEAM-3" }] } };
    expect(issueEdgeRefs({ node })).toEqual(["sub-issue|linear:TEAM-2", "sub-issue|linear:TEAM-3"]);
  });

  it("maps relation types to typed edges (blocks/duplicate/relation)", () => {
    const node = {
      relations: {
        nodes: [
          { relatedIssue: { identifier: "TEAM-9" }, type: "blocks" },
          { relatedIssue: { identifier: "TEAM-8" }, type: "duplicate" },
          { relatedIssue: { identifier: "TEAM-7" }, type: "related" },
        ],
      },
    };
    expect(issueEdgeRefs({ node })).toEqual([
      "blocks|linear:TEAM-9",
      "duplicate|linear:TEAM-8",
      "relation|linear:TEAM-7",
    ]);
  });

  it("dedupes and returns empty for an issue with no children or relations", () => {
    expect(issueEdgeRefs({ node: { title: "x" } })).toEqual([]);
  });
});

describe("issueAttachmentRefs — ref-only", () => {
  it("keeps title + url lines, never bytes", () => {
    const node = {
      attachments: {
        nodes: [
          { id: "a1", title: "Design doc", url: "https://figma/x" },
          { id: "a2", url: "https://x" },
        ],
      },
    };
    expect(issueAttachmentRefs({ node })).toEqual(["Design doc (https://figma/x)", "attachment (https://x)"]);
  });

  it("returns empty when there are no attachments", () => {
    expect(issueAttachmentRefs({ node: {} })).toEqual([]);
  });
});
