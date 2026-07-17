import { describe, expect, it } from "vitest";
import { isRecord } from "../lib/parsers.js";
import { err, ok, type Result, unwrap } from "../lib/result.js";
import type { LlmClient, LlmMessage } from "./provider.js";
import { completeStructured, type StructuredRequest } from "./structuredComplete.js";

const request: StructuredRequest = {
  schema: { required: ["n"], type: "object" },
  system: "sys",
  toolDescription: "emit it",
  toolName: "emit",
  user: "usr",
};

/** A client that replays a fixed sequence of messages, one per attempt. */
const clientOf = (messages: readonly LlmMessage[]): LlmClient => {
  let call = 0;
  return { complete: async () => messages[call++] ?? { content: [] } };
};

const toolUse = (input: unknown): LlmMessage => ({ content: [{ input, type: "tool_use" }] });
const textMsg = (text: string): LlmMessage => ({ content: [{ text, type: "text" }] });

const validate = (input: unknown): Result<number> =>
  isRecord(input) && typeof input["n"] === "number" ? ok(input["n"]) : err(["expected { n: number }"]);

const opts = { validate };

describe("completeStructured", () => {
  it("returns the validated value from a tool_use input", async () => {
    const result = await completeStructured({ client: clientOf([toolUse({ n: 7 })]), request, ...opts });
    expect(unwrap(result)).toBe(7);
  });

  it("retries past an invalid tool_use, then succeeds", async () => {
    const result = await completeStructured({
      client: clientOf([toolUse({ n: "nope" }), toolUse({ n: 3 })]),
      request,
      ...opts,
    });
    expect(unwrap(result)).toBe(3);
  });

  it("falls back to JSON found in a text block when there is no tool_use", async () => {
    const result = await completeStructured({ client: clientOf([textMsg('here: {"n":5}')]), request, ...opts });
    expect(unwrap(result)).toBe(5);
  });

  it("errs when the transport throws", async () => {
    const throwing: LlmClient = {
      complete: async () => {
        throw new Error("spawn failed");
      },
    };
    expect((await completeStructured({ client: throwing, request, ...opts })).ok).toBe(false);
  });

  it("errs after exhausting attempts on invalid output", async () => {
    const result = await completeStructured({
      client: clientOf([toolUse({ n: "a" }), toolUse({ n: "b" })]),
      request,
      ...opts,
    });
    expect(result.ok).toBe(false);
  });
});
