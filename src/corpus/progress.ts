/**
 * The source-agnostic progress seam the connectors emit through (PR4.4c). A connector's inner loop
 * (per-channel/thread for Slack, per-repo/item for GitHub, per-page for Linear/Notion) fires a
 * {@link SourceProgressEvent} — a heartbeat or a content-preview — and the refresh shell translates those
 * into the verb-level rich stream ({@link ../lib/progress.RichProgressEvent}). Keeping this seam in the
 * corpus layer means a connector never imports the CLI/emitter; it just calls a plain injected function.
 *
 * SECURITY: a preview's snippet MUST pass through {@link previewSnippet}, which runs the SAME redaction the
 * bronze writer uses ({@link ./redact.redactText}) — so a token/email/long-number can never leak into a
 * streamed progress line, exactly as it can't leak onto disk.
 */

import type { ProgressCurrentItem, ProgressPreview, RichProgressEvent } from "../lib/progress.js";
import { redactText } from "./redact.js";
import type { CorpusSource } from "./types.js";

/** How much of a preview snippet to show before eliding — enough for a taste, short enough for one line. */
export const PREVIEW_SNIPPET_CHARS = 120;

/** One progress event from inside a connector's crawl — a heartbeat or a content-preview (never a learning). */
export interface SourceProgressEvent {
  readonly lane: "heartbeat" | "content_preview";
  readonly source: CorpusSource;
  /** The sub-phase within the source (`channel`, `thread`, `repos`, `items`, `issues`, `pages`, …). */
  readonly phase: string;
  readonly done?: number;
  readonly total?: number;
  readonly currentItem?: ProgressCurrentItem;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly preview?: ProgressPreview;
}

/** The injected progress callback a connector calls (fire-and-forget; absent ⇒ no progress). */
export type SourceProgress = (event: SourceProgressEvent) => void;

/**
 * A one-line, redaction-safe preview snippet: run the FULL corpus redaction (tokens + emails + long
 * numbers), collapse whitespace, then cap to `maxChars` with an ellipsis. The redaction runs FIRST so a
 * secret can never survive the cap. Pure.
 *
 * @param text the raw item text
 * @param maxChars the cap (defaults to {@link PREVIEW_SNIPPET_CHARS})
 * @returns the redacted, collapsed, capped snippet
 */
export function previewSnippet({
  text,
  maxChars = PREVIEW_SNIPPET_CHARS,
}: {
  text: string;
  maxChars?: number;
}): string {
  const redacted = redactText({ text }).text.replace(/\s+/g, " ").trim();
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Build a heartbeat {@link SourceProgressEvent} (progress counts + the item being scanned). Pure.
 *
 * @param source the connector source
 * @param phase the sub-phase label
 * @param done items processed so far (optional)
 * @param total items expected (optional)
 * @param currentItem the item being scanned (optional)
 * @param metrics cheap running counters (optional)
 * @returns the heartbeat event
 */
export function sourceHeartbeat({
  source,
  phase,
  done,
  total,
  currentItem,
  metrics,
}: {
  source: CorpusSource;
  phase: string;
  done?: number;
  total?: number;
  currentItem?: ProgressCurrentItem;
  metrics?: Readonly<Record<string, number>>;
}): SourceProgressEvent {
  return {
    lane: "heartbeat",
    phase,
    source,
    ...(done !== undefined ? { done } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(currentItem !== undefined ? { currentItem } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
  };
}

/**
 * Build a content-preview {@link SourceProgressEvent} — a redacted taste of the item being read now.
 * `snippet` is redacted here so callers can pass raw text safely. Pure.
 *
 * @param source the connector source
 * @param phase the sub-phase label
 * @param subject the container (channel/repo/page) name
 * @param snippet the RAW item text (redacted here)
 * @param sourceContentId the cite (url/id)
 * @param sender the optional author
 * @returns the content-preview event
 */
export function sourcePreview({
  source,
  phase,
  subject,
  snippet,
  sourceContentId,
  sender,
}: {
  source: CorpusSource;
  phase: string;
  subject: string;
  snippet: string;
  sourceContentId: string;
  sender?: string;
}): SourceProgressEvent {
  const preview: ProgressPreview = {
    snippet: previewSnippet({ text: snippet }),
    sourceContentId,
    subject,
    ...(sender !== undefined ? { sender } : {}),
  };
  return { lane: "content_preview", phase, preview, source };
}

/**
 * Lift a connector's {@link SourceProgressEvent} into the verb-level {@link RichProgressEvent} the emitter
 * renders — namespacing the phase as `<source>.<phase>` (so the renderer derives the source token + human
 * step) and carrying the lane/counts/preview through unchanged. Pure.
 *
 * @param event the source-level event
 * @returns the rich, verb-level event
 */
export function toRichProgressEvent({ event }: { event: SourceProgressEvent }): RichProgressEvent {
  return {
    lane: event.lane,
    phase: `${event.source}.${event.phase}`,
    ...(event.done !== undefined ? { done: event.done } : {}),
    ...(event.total !== undefined ? { total: event.total } : {}),
    ...(event.currentItem !== undefined ? { currentItem: event.currentItem } : {}),
    ...(event.metrics !== undefined ? { metrics: event.metrics } : {}),
    ...(event.preview !== undefined ? { preview: event.preview } : {}),
  };
}
