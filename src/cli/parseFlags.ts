/**
 * The one flag parser, built on Node's built-in `node:util` `parseArgs` — so verbs never hand-roll
 * `rest.indexOf('--x')` / `startsWith('--')` loops again. It runs `parseArgs` in non-strict mode (so it
 * never throws) and folds the result into this repo's `Result` + error-list style:
 *   - an unknown flag → `unknown flag: --x`
 *   - a value flag given with no value → `--x requires a value`
 *   - a stray positional when positionals aren't allowed → `unexpected argument: x`
 * When positionals ARE allowed (the query verbs' free-text tail), they're returned for the caller to join.
 *
 * Pure: no I/O. `parseArgs` is a stdlib primitive used positionally, so it's exempt from the named-object
 * rule the way `logger.info(msg)` is; everything here otherwise follows the house style.
 */
import { parseArgs } from "node:util";

import { err, ok, type Result } from "../lib/result.js";

/** Which flags take a value (`--home x`) vs are boolean switches (`--json`). Names omit the `--`. */
export interface FlagSpec {
  readonly string?: readonly string[];
  readonly boolean?: readonly string[];
}

/** Parsed flags: declared values (string or boolean), plus any positionals (for a free-text tail). */
export interface ParsedFlags {
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly positionals: readonly string[];
}

/** The raw tokenizer result — values + positionals + accumulated errors, WITHOUT short-circuiting. */
export interface FlagTokens extends ParsedFlags {
  readonly errors: readonly string[];
}

/** The `parseArgs` options map for a spec (each declared flag typed string/boolean). Pure. */
function flagOptions({
  stringKeys,
  boolKeys,
}: {
  stringKeys: ReadonlySet<string>;
  boolKeys: ReadonlySet<string>;
}): Record<string, { type: "string" | "boolean" }> {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const key of stringKeys) {
    options[key] = { type: "string" };
  }
  for (const key of boolKeys) {
    options[key] = { type: "boolean" };
  }
  return options;
}

/**
 * Classify one parsed `--flag value` entry: an unknown flag, a value-flag missing its value (parseArgs
 * yields `true`, or "ate" the next `--flag`), an absent value to skip, or an accepted value. Pure.
 *
 * @returns an `error` to accumulate, an `accepted` value to keep, or neither (skip)
 */
function classifyFlagEntry({
  key,
  value,
  stringKeys,
  boolKeys,
}: {
  key: string;
  value: string | boolean | undefined;
  stringKeys: ReadonlySet<string>;
  boolKeys: ReadonlySet<string>;
}): { readonly error?: string; readonly accepted?: string | boolean } {
  if (!stringKeys.has(key) && !boolKeys.has(key)) {
    return { error: `unknown flag: --${key}` };
  }
  if (value === undefined) {
    return {};
  }
  if (stringKeys.has(key) && (typeof value !== "string" || value.startsWith("--"))) {
    return { error: `--${key} requires a value` };
  }
  return { accepted: value };
}

/**
 * Tokenise an argv tail against a flag spec, ACCUMULATING every rejection (never short-circuits, so a
 * caller can add its own value-validation errors to the same list). Never throws. A thin fold over the
 * pure {@link flagOptions} + {@link classifyFlagEntry}.
 *
 * @param args the argv tail (after the noun/verb)
 * @param spec the string + boolean flag names to accept
 * @param allowPositionals keep positionals (true, for a free-text tail) or reject them as errors (false)
 * @returns `{ values, positionals, errors }`
 */
export function tokenizeFlags({
  args,
  spec,
  allowPositionals = false,
}: {
  args: readonly string[];
  spec: FlagSpec;
  allowPositionals?: boolean;
}): FlagTokens {
  const stringKeys = new Set(spec.string ?? []);
  const boolKeys = new Set(spec.boolean ?? []);

  // strict:false ⇒ unknown flags land in `values` (as `true`) and missing string values become `true`,
  // rather than throwing — we turn both into our own domain errors below.
  const parsed = parseArgs({
    allowPositionals: true,
    args: [...args],
    options: flagOptions({ boolKeys, stringKeys }),
    strict: false,
  });

  const errors: string[] = [];
  const values: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(parsed.values)) {
    const classified = classifyFlagEntry({ boolKeys, key, stringKeys, value });
    if (classified.error !== undefined) {
      errors.push(classified.error);
    } else if (classified.accepted !== undefined) {
      values[key] = classified.accepted;
    }
  }
  if (!allowPositionals) {
    for (const positional of parsed.positionals) {
      errors.push(`unexpected argument: ${positional}`);
    }
  }
  return { errors, positionals: parsed.positionals, values };
}

/**
 * Parse an argv tail against a flag spec, as a `Result`. The short-circuiting wrapper over
 * {@link tokenizeFlags} for verbs that reject on any bad flag.
 *
 * @param args the argv tail (after the noun/verb)
 * @param spec the string + boolean flag names to accept
 * @param allowPositionals keep positionals (true) or reject them as errors (false)
 * @returns the parsed `{ values, positionals }`, or an error listing every rejection
 */
export function parseFlags({
  args,
  spec,
  allowPositionals = false,
}: {
  args: readonly string[];
  spec: FlagSpec;
  allowPositionals?: boolean;
}): Result<ParsedFlags> {
  const { values, positionals, errors } = tokenizeFlags({ allowPositionals, args, spec });
  return errors.length > 0 ? err(errors) : ok({ positionals, values });
}
