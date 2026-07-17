/**
 * Exponential recency decay for ranking. Pure. `now` is always INJECTED — never `Date.now()` inside the
 * ranker — so retrieval is deterministic and testable. A record's weight halves every `halfLifeMs`.
 */

const MS_PER_DAY = 86_400_000;
export const DEFAULT_HALF_LIFE_MS = 7 * MS_PER_DAY;
/** A record with no timestamp is floored just above 0 rather than dropped. */
const MISSING_TS_EPSILON = 1e-6;

export interface DecayParams {
  readonly nowMs: number;
  readonly halfLifeMs?: number;
}

/**
 * Decay weight in (0,1]: 1 at `nowMs`, halving every half-life. Future/degenerate inputs clamp to 1.
 *
 * @param tsMs the record time in ms
 * @param nowMs the reference "now" in ms
 * @param halfLifeMs the half-life in ms (default {@link DEFAULT_HALF_LIFE_MS})
 * @returns the decay weight
 */
export function decayWeight({
  tsMs,
  nowMs,
  halfLifeMs = DEFAULT_HALF_LIFE_MS,
}: { tsMs: number } & DecayParams): number {
  if (halfLifeMs <= 0) {
    return 1;
  }
  const ageMs = Math.max(0, nowMs - tsMs);
  return 0.5 ** (ageMs / halfLifeMs);
}

/**
 * Decay weight for a record's (maybe-missing) timestamp — a missing ts is floored, never dropped.
 *
 * @param tsMs the record time in ms, or undefined
 * @param nowMs the reference "now" in ms
 * @param halfLifeMs the half-life in ms (default {@link DEFAULT_HALF_LIFE_MS})
 * @returns the decay weight
 */
export function recordDecayWeight({
  tsMs,
  nowMs,
  halfLifeMs = DEFAULT_HALF_LIFE_MS,
}: { tsMs: number | undefined } & DecayParams): number {
  if (tsMs === undefined) {
    return MISSING_TS_EPSILON;
  }
  return decayWeight({ halfLifeMs, nowMs, tsMs });
}

/**
 * Parse an ISO timestamp to ms, or undefined when unparseable.
 *
 * @param tsIso the ISO timestamp
 * @returns ms since epoch, or undefined
 */
export function tsIsoToMs({ tsIso }: { tsIso: string }): number | undefined {
  const ms = Date.parse(tsIso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Build decay params from a half-life expressed in days (or undefined for the default).
 *
 * @param days the half-life in days, or undefined
 * @param nowMs the reference "now" in ms
 * @returns the decay params
 */
export function decayParamsFromDays({ days, nowMs }: { days: number | undefined; nowMs: number }): DecayParams {
  return days !== undefined && days > 0 ? { halfLifeMs: days * MS_PER_DAY, nowMs } : { nowMs };
}
