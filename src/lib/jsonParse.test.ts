import { describe, expect, it } from "vitest";
import { parseJson, parseJsonLine, parseJsonObject } from "./jsonParse.js";

describe("parseJson", () => {
  it("parses a valid object", () => {
    const result = parseJson({ text: '{"a":1}' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ a: 1 });
  });

  it("parses a valid array", () => {
    const result = parseJson({ text: "[1,2,3]" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([1, 2, 3]);
  });

  it("returns invalid JSON for malformed text", () => {
    const result = parseJson({ text: "{not json" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("invalid JSON");
  });
});

describe("parseJsonObject", () => {
  it("parses an object", () => {
    const result = parseJsonObject({ text: '{"k":"v"}' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ k: "v" });
  });

  it("rejects an array as not an object", () => {
    const result = parseJsonObject({ text: "[1]" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("not a JSON object");
  });

  it("rejects null as not an object", () => {
    const result = parseJsonObject({ text: "null" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("not a JSON object");
  });

  it("propagates invalid JSON", () => {
    const result = parseJsonObject({ text: "oops" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("invalid JSON");
  });
});

describe("parseJsonLine", () => {
  it("parses a line with surrounding whitespace", () => {
    const result = parseJsonLine({ line: '  {"n":2}  ' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ n: 2 });
  });

  it("returns empty line for a blank line", () => {
    const result = parseJsonLine({ line: "   " });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("empty line");
  });

  it("returns invalid JSON for a malformed line", () => {
    const result = parseJsonLine({ line: "{bad" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("invalid JSON");
  });
});
