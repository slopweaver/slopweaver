import { describe, expect, it } from "vitest";
import { classifyCurated } from "./classify.js";

describe("classifyCurated — kind defaults", () => {
  it("tags a Linear project update as status from its kind alone", () => {
    expect(classifyCurated({ kind: "update", text: "" })).toBe("status");
  });

  it("tags a CODEOWNERS file as ownership from its kind alone", () => {
    expect(classifyCurated({ kind: "codeowners", text: "* @team" })).toBe("ownership");
  });

  it("tags an initiative as strategy from its kind alone", () => {
    expect(classifyCurated({ kind: "initiative", text: "" })).toBe("strategy");
  });

  it("tags a Slack canvas as strategy from its kind alone", () => {
    expect(classifyCurated({ kind: "canvas", text: "" })).toBe("strategy");
  });

  it("tags a GitHub release as status from its kind alone", () => {
    expect(classifyCurated({ kind: "release", text: "" })).toBe("status");
  });
});

describe("classifyCurated — keyword fallback for ambiguous kinds", () => {
  it("classifies an RFC-titled discussion as a decision", () => {
    expect(classifyCurated({ kind: "discussion", text: "body", title: "RFC: adopt neverthrow" })).toBe("decision");
  });

  it("classifies a roadmap document as strategy", () => {
    expect(classifyCurated({ kind: "document", text: "Our roadmap for Q3" })).toBe("strategy");
  });

  it("classifies a status-update page as status", () => {
    expect(classifyCurated({ kind: "page", text: "on track", title: "Weekly update" })).toBe("status");
  });

  it("classifies an ownership page as ownership", () => {
    expect(classifyCurated({ kind: "page", text: "This area is owned by the platform team" })).toBe("ownership");
  });

  it("leaves a plain firehose message untagged", () => {
    expect(classifyCurated({ kind: "message", text: "lgtm shipping now" })).toBe(undefined);
  });
});

describe("classifyCurated — kind default beats a body keyword", () => {
  it("keeps an initiative as strategy even when its body mentions a decision", () => {
    expect(classifyCurated({ kind: "initiative", text: "the decision was to defer" })).toBe("strategy");
  });
});
