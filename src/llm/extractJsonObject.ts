/**
 * Pull JSON objects out of a model's text output — which may be bare JSON, fenced in ```json, or
 * embedded in prose (and may echo the schema before the real answer). Pure. First tries a direct parse;
 * otherwise scans every balanced top-level `{…}` span, string- and escape-aware so a brace inside a
 * quoted value never closes early. Returns EVERY span in order, so a caller can validate past an
 * echoed-schema object that precedes the answer.
 *
 * The brace scanner is a small state machine: the per-character transition is split into two pure steps
 * ({@link stepInsideString}, {@link stepOutsideString}) so each stays well under the complexity ceiling and
 * is individually testable, while {@link balancedObjectSpans} just folds them over the input.
 */
import { parseJson } from "../lib/jsonParse.js";
import { isRecord } from "../lib/parsers.js";

/** The brace-scanner's state as it walks the text. */
interface ScanState {
  readonly depth: number;
  readonly start: number;
  readonly inString: boolean;
  readonly escaped: boolean;
}

const INITIAL_SCAN: ScanState = { depth: 0, escaped: false, inString: false, start: -1 };

/** Advance the state for a character seen INSIDE a string literal (tracking escapes + the closing quote). */
function stepInsideString({ state, ch }: { state: ScanState; ch: string }): ScanState {
  if (state.escaped) {
    return { ...state, escaped: false };
  }
  if (ch === "\\") {
    return { ...state, escaped: true };
  }
  if (ch === '"') {
    return { ...state, inString: false };
  }
  return state;
}

/**
 * Advance the state for a character seen OUTSIDE a string, returning the new state plus a completed
 * `[start, end)` span when a top-level object just closed.
 */
function stepOutsideString({ state, ch, index }: { state: ScanState; ch: string; index: number }): {
  readonly state: ScanState;
  readonly span?: readonly [number, number];
} {
  if (ch === '"') {
    return { state: { ...state, inString: true } };
  }
  if (ch === "{") {
    return { state: { ...state, depth: state.depth + 1, start: state.depth === 0 ? index : state.start } };
  }
  if (ch === "}" && state.depth > 0) {
    const depth = state.depth - 1;
    if (depth === 0 && state.start >= 0) {
      return { span: [state.start, index + 1], state: { ...state, depth } };
    }
    return { state: { ...state, depth } };
  }
  return { state };
}

/** Every balanced top-level `{…}` substring of `text`, in order. Pure. */
function balancedObjectSpans({ text }: { text: string }): readonly string[] {
  const spans: string[] = [];
  let state = INITIAL_SCAN;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (state.inString) {
      state = stepInsideString({ ch, state });
      continue;
    }
    const stepped = stepOutsideString({ ch, index: i, state });
    state = stepped.state;
    if (stepped.span !== undefined) {
      spans.push(text.slice(stepped.span[0], stepped.span[1]));
    }
  }
  return spans;
}

/**
 * Every JSON object parseable out of `text`, in order (direct parse first, else balanced spans). Pure.
 *
 * @param text the raw model output
 * @returns every parseable top-level object, in appearance order
 */
export function extractJsonObjects({ text }: { text: string }): readonly Record<string, unknown>[] {
  const direct = parseJson({ text: text.trim() });
  if (direct.isOk() && isRecord(direct.value)) {
    return [direct.value];
  }
  const objects: Record<string, unknown>[] = [];
  for (const span of balancedObjectSpans({ text })) {
    const parsed = parseJson({ text: span });
    if (parsed.isOk() && isRecord(parsed.value)) {
      objects.push(parsed.value);
    }
  }
  return objects;
}

/**
 * The first JSON object in `text`, or undefined. Pure.
 *
 * @param text the raw model output
 * @returns the first parseable object, or `undefined`
 */
export function extractJsonObject({ text }: { text: string }): Record<string, unknown> | undefined {
  return extractJsonObjects({ text })[0];
}
