/**
 * Shared arg parsing for the query verbs (`ask`, `facts`): a free-text QUESTION (all non-flag tokens,
 * joined) plus flags. Tokenising is delegated to {@link tokenizeFlags} (Node's `parseArgs`) with
 * positionals kept as the question; this module adds the value validators (positive-int, fraction, …).
 * Pure — errors are accumulated, not thrown.
 */
import { tokenizeFlags } from "../parseFlags.js";

export interface QueryArgs {
  readonly home?: string;
  readonly corpus?: string;
  readonly limit: number;
  readonly alpha?: number;
  readonly semantic: boolean;
  /** Emit one machine-readable JSON object on stdout instead of the pretty answer. */
  readonly json: boolean;
  readonly halfLifeDays?: number;
  readonly question: string;
  readonly errors: readonly string[];
}

function positiveInt({
  raw,
  label,
  errors,
  fallback,
}: {
  raw: string;
  label: string;
  errors: string[];
  fallback: number;
}): number {
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  errors.push(`${label} must be a positive integer`);
  return fallback;
}

function fraction({ raw, label, errors }: { raw: string; label: string; errors: string[] }): number | undefined {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  errors.push(`${label} must be between 0 and 1`);
  return undefined;
}

function positiveNumber({ raw, label, errors }: { raw: string; label: string; errors: string[] }): number | undefined {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  errors.push(`${label} must be a positive number`);
  return undefined;
}

/** Read a string-valued flag from the tokenised values (booleans/absent ⇒ undefined). */
function stringValue({
  values,
  key,
}: {
  values: Readonly<Record<string, string | boolean>>;
  key: string;
}): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse a query verb's argv tail into a question + flags.
 *
 * @param rest the argv tail (after the noun)
 * @param defaultLimit the default slice size
 * @returns the parsed args (with accumulated `errors`)
 */
export function parseQueryArgs({ rest, defaultLimit }: { rest: readonly string[]; defaultLimit: number }): QueryArgs {
  const {
    values,
    positionals,
    errors: tokenErrors,
  } = tokenizeFlags({
    allowPositionals: true,
    args: rest,
    spec: { boolean: ["no-semantic", "json"], string: ["home", "corpus", "limit", "alpha", "half-life-days"] },
  });
  const errors = [...tokenErrors];
  const home = stringValue({ key: "home", values });
  const corpus = stringValue({ key: "corpus", values });
  const limitRaw = stringValue({ key: "limit", values });
  const alphaRaw = stringValue({ key: "alpha", values });
  const halfLifeRaw = stringValue({ key: "half-life-days", values });
  const alpha = alphaRaw !== undefined ? fraction({ errors, label: "--alpha", raw: alphaRaw }) : undefined;
  const halfLifeDays =
    halfLifeRaw !== undefined ? positiveNumber({ errors, label: "--half-life-days", raw: halfLifeRaw }) : undefined;

  return {
    ...(home !== undefined ? { home } : {}),
    ...(corpus !== undefined ? { corpus } : {}),
    limit:
      limitRaw !== undefined
        ? positiveInt({ errors, fallback: defaultLimit, label: "--limit", raw: limitRaw })
        : defaultLimit,
    ...(alpha !== undefined ? { alpha } : {}),
    json: values["json"] === true,
    semantic: values["no-semantic"] !== true,
    ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
    errors,
    question: positionals.join(" "),
  };
}
