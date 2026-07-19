/**
 * Date/epoch conversions that had been reimplemented across refresh, the Slack + Notion connectors, and
 * the silver/retrieval recency helpers. Pure — the "now" is injected (never `new Date()` inside), so the
 * window arithmetic is unit-testable against a fixed clock. All calendar maths is UTC.
 */

/** `YYYY-MM-DD` for the UTC calendar day of `date`. */
function toYyyyMmDd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The UTC calendar day `days` from `now`, as `YYYY-MM-DD` — the refresh window's "today ± N" bound. Pure:
 * `now` is injected and never mutated. Preserves the old `setUTCDate` + `toISOString().slice(0,10)` shape.
 *
 * @param now the reference instant (the shell injects the real clock)
 * @param days the offset in days (negative for the past)
 * @returns the offset day as `YYYY-MM-DD`
 */
export function yyyyMmDdTodayPlus({ now, days }: { now: Date; days: number }): string {
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return toYyyyMmDd(date);
}

/**
 * `days` before a `YYYY-MM-DD` date, as `YYYY-MM-DD`. Pure.
 *
 * @param date the anchor day (`YYYY-MM-DD`)
 * @param days how many days before it
 * @returns the earlier day as `YYYY-MM-DD`
 */
export function yyyyMmDdMinusDays({ date, days }: { date: string; days: number }): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return toYyyyMmDd(parsed);
}

/**
 * A `YYYY-MM-DD` day bound → ms since epoch at UTC midnight, or `undefined` when unparseable. Pure —
 * the Notion cutoff + Slack window bounds both start here.
 *
 * @param date the `YYYY-MM-DD` bound
 * @returns UTC-midnight ms, or `undefined` if not a finite date
 */
export function parseYyyyMmDdUtcMs({ date }: { date: string }): number | undefined {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * A `YYYY-MM-DD` day bound → whole epoch seconds at UTC midnight, or `undefined` when unparseable (the
 * Slack `oldest`/`latest` bound; the caller supplies its own fallback string). Pure.
 *
 * @param date the `YYYY-MM-DD` bound
 * @returns floored epoch seconds, or `undefined` if not a finite date
 */
export function yyyyMmDdToEpochSeconds({ date }: { date: string }): number | undefined {
  const ms = parseYyyyMmDdUtcMs({ date });
  return ms === undefined ? undefined : Math.floor(ms / 1000);
}

/**
 * An ISO-8601 timestamp → ms since epoch, or `undefined` when unparseable — the recency helpers' invalid
 * convention (callers that want 0 coalesce with `?? 0`). Pure.
 *
 * @param tsIso the ISO timestamp
 * @returns ms since epoch, or `undefined`
 */
export function parseIsoMs({ tsIso }: { tsIso: string }): number | undefined {
  const ms = Date.parse(tsIso);
  return Number.isNaN(ms) ? undefined : ms;
}
