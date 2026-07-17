/**
 * Pull JSON objects out of a model's text output — which may be bare JSON, fenced in ```json, or
 * embedded in prose (and may echo the schema before the real answer). Pure. First tries a direct parse;
 * otherwise scans every balanced top-level `{…}` span, string- and escape-aware so a brace inside a
 * quoted value never closes early. Returns EVERY span in order, so a caller can validate past an
 * echoed-schema object that precedes the answer.
 */
import { isRecord } from "../lib/parsers.js";

/** Every balanced top-level `{…}` substring of `text`, in order. */
function balancedObjectSpans({ text }: { text: string }): readonly string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
      }
    }
  }
  return spans;
}

/** Every JSON object parseable out of `text`, in order (direct parse first, else balanced spans). */
export function extractJsonObjects({ text }: { text: string }): readonly Record<string, unknown>[] {
  const trimmed = text.trim();
  try {
    const direct: unknown = JSON.parse(trimmed);
    if (isRecord(direct)) {
      return [direct];
    }
  } catch {
    // fall through to span scanning
  }
  const objects: Record<string, unknown>[] = [];
  for (const span of balancedObjectSpans({ text })) {
    try {
      const parsed: unknown = JSON.parse(span);
      if (isRecord(parsed)) {
        objects.push(parsed);
      }
    } catch {
      // skip unparseable spans
    }
  }
  return objects;
}

/** The first JSON object in `text`, or undefined. */
export function extractJsonObject({ text }: { text: string }): Record<string, unknown> | undefined {
  return extractJsonObjects({ text })[0];
}
