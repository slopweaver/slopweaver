/**
 * The PURE human renderers for the streamed progress lanes (PR4.4c). They turn a {@link ProgressSnapshot}
 * or a preview/learning payload into ONE terminal line — never JSON, never a spinner/cursor control — so a
 * long crawl reads as a calm, throttled stream of human sentences on stderr. Every function here is pure
 * and unit-tested against exact strings; the effectful emit (which sink, when) lives in
 * {@link ./progress.createRichProgressEmitter}.
 *
 * Snippets/learnings are rendered VERBATIM — the caller is responsible for redacting content BEFORE it
 * reaches a preview (see {@link ../corpus/progress.previewSnippet}); a renderer never sees a raw secret.
 */

import type { ProgressLearning, ProgressPreview, ProgressSnapshot } from "./progress.js";

/** The field separator shared by every rendered line — a spaced middot, so lines read as clauses. */
const SEP = " · ";

/**
 * Group a non-negative integer with thousands separators, deterministically (no locale dependence). Pure.
 *
 * @param value the number to format (truncated to an integer)
 * @returns the grouped string (e.g. `12420` → `12,420`)
 */
export function groupThousands({ value }: { value: number }): string {
  const digits = Math.trunc(Math.abs(value)).toString();
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += ",";
    }
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}

/**
 * A compact human duration from seconds — `40s` / `14m` / `2h`. Coarse on purpose: an ETA is an estimate,
 * so a rounded single unit reads better than `13m 47s`. Pure.
 *
 * @param seconds the duration in seconds
 * @returns the compact string
 */
export function humanDuration({ seconds }: { seconds: number }): string {
  if (seconds < 60) {
    return `${String(Math.round(seconds))}s`;
  }
  if (seconds < 3600) {
    return `${String(Math.round(seconds / 60))}m`;
  }
  return `${String(Math.round(seconds / 3600))}h`;
}

/** The metric clauses (`12,420 messages`, `7 skipped`) in insertion order. Pure. */
function metricClauses({ metrics }: { metrics: Readonly<Record<string, number>> }): readonly string[] {
  return Object.entries(metrics).map(([key, value]) => `${groupThousands({ value })} ${key}`);
}

/**
 * Render one heartbeat line: `verb [source] · step · currentItem · NN% · ETA Nm · <metrics>`, with each
 * clause dropped when it has no value (so a pre-data heartbeat is just `verb · step`), and a `(stalled)`
 * marker appended when the watchdog fired. Pure.
 *
 * @param snapshot the render-ready heartbeat snapshot
 * @returns the single human line
 */
export function renderHeartbeatLine({ snapshot }: { snapshot: ProgressSnapshot }): string {
  const head = snapshot.source !== undefined ? `${snapshot.verb} ${snapshot.source}` : snapshot.verb;
  const clauses: string[] = [head, snapshot.step];
  if (snapshot.currentItem !== undefined) {
    clauses.push(snapshot.currentItem.title);
  }
  if (snapshot.percent !== undefined) {
    clauses.push(`${String(snapshot.percent)}%`);
  }
  if (snapshot.etaSeconds !== undefined) {
    clauses.push(`ETA ${humanDuration({ seconds: snapshot.etaSeconds })}`);
  }
  clauses.push(...metricClauses({ metrics: snapshot.metrics }));
  const line = clauses.join(SEP);
  return snapshot.stalled ? `${line}${SEP}(stalled)` : line;
}

/**
 * Render one content-preview line: an indented taste of what's being read now, cited. `subject` is the
 * container (a channel/repo/page), `sender` an optional author, `snippet` the ALREADY-REDACTED text. Pure.
 *
 * @param preview the preview payload
 * @returns the single human line
 */
export function renderPreviewLine({ preview }: { preview: ProgressPreview }): string {
  const sender = preview.sender !== undefined ? `${SEP}${preview.sender}` : "";
  return `  ↳ ${preview.subject}${sender}${SEP}"${preview.snippet}" [${preview.sourceContentId}]`;
}

/**
 * Render one learning line: an indented "learned …" with its category/confidence + grounding cite. Pure.
 *
 * @param learning the learning payload
 * @returns the single human line
 */
export function renderLearningLine({ learning }: { learning: ProgressLearning }): string {
  return `  ↳ learned ${learning.category}/${learning.confidence}${SEP}${learning.content} [${learning.sourceContentId}]`;
}

/** A rendered-ready progress event — one variant per lane, bundling exactly what its renderer needs. */
export type RenderableProgressEvent =
  | { readonly lane: "heartbeat"; readonly snapshot: ProgressSnapshot }
  | { readonly lane: "content_preview"; readonly preview: ProgressPreview }
  | { readonly lane: "knowledge_extracted"; readonly learning: ProgressLearning };

/**
 * Dispatch a renderable event to its lane renderer — the single entry point the emitter renders through.
 * Pure.
 *
 * @param event the renderable event (a snapshot / preview / learning tagged by lane)
 * @returns the single human line
 */
export function renderProgressEvent({ event }: { event: RenderableProgressEvent }): string {
  if (event.lane === "content_preview") {
    return renderPreviewLine({ preview: event.preview });
  }
  if (event.lane === "knowledge_extracted") {
    return renderLearningLine({ learning: event.learning });
  }
  return renderHeartbeatLine({ snapshot: event.snapshot });
}
