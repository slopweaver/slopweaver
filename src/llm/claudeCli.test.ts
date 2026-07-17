import { describe, expect, it } from "vitest";
import { buildPrompt, envelopeToMessage } from "./claudeCli.js";
import type { LlmCreateParams } from "./provider.js";

const baseParams: LlmCreateParams = {
  messages: [{ content: "summarise this", role: "user" }],
  system: "You are helpful.",
};

describe("buildPrompt", () => {
  it("joins system + messages", () => {
    expect(buildPrompt({ params: baseParams })).toBe("You are helpful.\n\nsummarise this");
  });

  it("appends a schema instruction when a forced tool is present", () => {
    const params: LlmCreateParams = {
      ...baseParams,
      toolChoice: { name: "emit", type: "tool" },
      tools: [{ description: "d", inputSchema: { required: ["x"], type: "object" }, name: "emit" }],
    };
    const prompt = buildPrompt({ params });
    expect(prompt).toContain("Respond with ONLY a JSON object");
    expect(prompt).toContain('"required":["x"]');
  });
});

describe("envelopeToMessage", () => {
  it("recovers a tool_use block + text block from a good envelope", () => {
    const stdout = JSON.stringify({ is_error: false, result: 'answer: {"summary":"hi"}' });
    const message = envelopeToMessage({ stdout });
    expect(message.content[0]).toEqual({ input: { summary: "hi" }, type: "tool_use" });
    expect(message.content[1]!.type).toBe("text");
  });

  it("throws on an error envelope", () => {
    expect(() => envelopeToMessage({ stdout: JSON.stringify({ is_error: true, result: "boom" }) })).toThrow();
  });

  it("throws when result is not a string", () => {
    expect(() => envelopeToMessage({ stdout: JSON.stringify({ result: 42 }) })).toThrow();
  });
});
