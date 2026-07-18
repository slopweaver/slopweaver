import { describe, expect, it } from "vitest";
import type { Answer } from "../../../retrieval/answerFromSlice.js";
import { renderAskJson } from "./askJson.js";

const answer: Answer = {
  answer: "auth uses tokens (#1)\n\nthe longer body (#2)",
  citations: ["u1", "u2"],
  citedTokens: ["#1", "#2"],
  details: "the longer body (#2)",
  retrieved: 3,
  retrievedRefs: [
    { sourceId: "#1", token: "#1", url: "u1" },
    { sourceId: "#2", token: "#2", url: "u2" },
    { sourceId: "#9", token: "#9", url: "u9" },
  ],
  tldr: "auth uses tokens (#1)",
  used: 2,
};

describe("renderAskJson", () => {
  it("serialises the answer to a parseable object exposing slice refs apart from citations", () => {
    const parsed = JSON.parse(renderAskJson({ answer, question: "how does auth work" }));
    expect(parsed).toEqual({
      answer: "auth uses tokens (#1)\n\nthe longer body (#2)",
      citations: ["u1", "u2"],
      citedTokens: ["#1", "#2"],
      details: "the longer body (#2)",
      question: "how does auth work",
      retrieved: 3,
      retrievedRefs: [
        { sourceId: "#1", token: "#1", url: "u1" },
        { sourceId: "#2", token: "#2", url: "u2" },
        { sourceId: "#9", token: "#9", url: "u9" },
      ],
      tldr: "auth uses tokens (#1)",
      used: 2,
    });
  });

  it("renders a missing details as null (a stable key the harness can rely on)", () => {
    const { details: _details, ...noDetails } = answer;
    expect(JSON.parse(renderAskJson({ answer: noDetails, question: "q" })).details).toBe(null);
  });
});
