/**
 * Tolerant JSON parsing — the `try { JSON.parse } catch { … }` shape reimplemented in the corpus store,
 * vector cache, watermark/thread-cursor readers, identity store, and the LLM envelope extractor. Each
 * returns a typed {@link TypedResult} of the raw parsed value (or an error string); the DOMAIN validation
 * of that value stays at the call-site (it's source-specific and never belongs in a generic helper). Pure.
 */
import { isRecord } from "./parsers.js";
import { type TypedResult, typedErr, typedOk } from "./result.js";

/**
 * Parse JSON text into an unknown value, mapping a `SyntaxError` to a typed error rather than a throw. Pure.
 *
 * @param text the JSON text
 * @returns the parsed value, or `"invalid JSON"`
 */
export function parseJson({ text }: { text: string }): TypedResult<unknown, string> {
  try {
    const value: unknown = JSON.parse(text);
    return typedOk(value);
  } catch {
    return typedErr("invalid JSON");
  }
}

/**
 * Parse JSON text that must be an object (not an array or primitive). Pure — the shape beyond "is an
 * object" is the caller's to validate.
 *
 * @param text the JSON text
 * @returns the parsed object, `"invalid JSON"`, or `"not a JSON object"`
 */
export function parseJsonObject({ text }: { text: string }): TypedResult<Record<string, unknown>, string> {
  return parseJson({ text }).andThen((value) =>
    isRecord(value) ? typedOk(value) : typedErr<Record<string, unknown>, string>("not a JSON object"),
  );
}

/**
 * Parse one NDJSON line — a blank/whitespace-only line is a typed error (never a throw), otherwise it
 * defers to {@link parseJson}. Pure.
 *
 * @param line the raw line
 * @returns the parsed value, `"empty line"`, or `"invalid JSON"`
 */
export function parseJsonLine({ line }: { line: string }): TypedResult<unknown, string> {
  if (line.trim().length === 0) {
    return typedErr("empty line");
  }
  return parseJson({ text: line });
}
