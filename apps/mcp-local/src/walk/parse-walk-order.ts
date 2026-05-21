/**
 * Parser for the `## Walk order (priority-ranked)` section of a
 * reconciliation.md file. Pure function — input markdown, output
 * an ordered list of WalkItem objects.
 *
 * Expected line shape (per the /reconcile prompt body):
 *
 *   1. **[anchor](url)** — `[priority-N | rank=0-LIVE]` — <description>. *(<source-bucket>)*
 *
 * The parser is liberal — it accepts:
 *   - Items numbered with `1.`, `2.` etc.
 *   - Items with or without the bold anchor.
 *   - Items with or without the priority bracket.
 *   - Items with or without the source-bucket italic tail.
 *
 * Anything outside the `## Walk order` section is ignored. Stops at
 * the next `##` heading.
 *
 * Items with an empty stripped description are skipped AND surfaced
 * as a parse warning so the upstream malformation isn't invisible
 * (a bare `1.` or `1. **[X](https://x/)**` with no payload would
 * otherwise vanish silently from the queue).
 *
 * Duplicate logical items (same `anchor_url`, or same `anchor` text
 * when no URL is present) cause the parser to return an `Err` with
 * code `WALK_ORDER_DUPLICATE`. The walk queue is meant to be a
 * de-duplicated ranked list; duplicates indicate the upstream
 * reconciliation pipeline produced a malformed file.
 */

import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@slopweaver/errors';

export type WalkItem = {
  readonly id: string;
  readonly anchor: string | null;
  readonly anchor_url: string | null;
  readonly priority: string | null;
  readonly description: string;
  readonly source_bucket: string | null;
};

export type WalkParseSuccess = {
  readonly items: ReadonlyArray<WalkItem>;
  readonly warnings: ReadonlyArray<string>;
};

export interface WalkOrderDuplicateError {
  readonly code: 'WALK_ORDER_DUPLICATE';
  readonly message: string;
  readonly duplicates: ReadonlyArray<WalkItem>;
}

export type WalkParseError = WalkOrderDuplicateError;

const WalkErrors = {
  duplicate: (duplicates: ReadonlyArray<WalkItem>): WalkOrderDuplicateError => ({
    code: 'WALK_ORDER_DUPLICATE',
    message: `Walk order contains ${duplicates.length} duplicate item(s); the reconciliation pipeline produced a malformed list.`,
    duplicates,
  }),
} as const;

const SECTION_HEADING = /^##\s+walk order/i;
const NEXT_HEADING = /^##\s+/;
const NUMBERED_LINE = /^\s*\d+\./;
const ANCHOR_RE = /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/;
const PRIORITY_RE = /`\[([^\]]+)\]`/;
const SOURCE_BUCKET_RE = /\*\(([^)]+)\)\*\s*$/;

/**
 * Parse a reconciliation.md body into the ranked WalkItem list.
 *
 * Item ids are content-derived: a short sha1 hash of
 * `anchor_url || anchor || description`. This makes ids stable across
 * input reformats (inserting / deleting blank lines or comments above
 * a row does not churn its id), but ids do change when the item's
 * content changes — that's the intended semantics for a `/lock-in`
 * state machine that wants to detect "this item is no longer the same
 * piece of work."
 *
 * @param markdown the raw file contents (CRLF and LF both accepted)
 * @returns the parsed queue plus any parse warnings, or an `Err` if
 *   duplicates are detected
 */
export function parseWalkOrder(markdown: string): Result<WalkParseSuccess, WalkParseError> {
  // Normalise CRLF / CR line endings so the line-by-line walk is
  // platform-independent.
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const items: WalkItem[] = [];
  const warnings: string[] = [];
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNumber = i + 1;

    if (SECTION_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (NEXT_HEADING.test(line)) break;
    if (!NUMBERED_LINE.test(line)) continue;

    const body = line.replace(/^\s*\d+\.\s*/, '').trim();
    const anchorMatch = ANCHOR_RE.exec(body);
    const priorityMatch = PRIORITY_RE.exec(body);
    const sourceMatch = SOURCE_BUCKET_RE.exec(body);

    const description = body
      .replace(ANCHOR_RE, '')
      .replace(PRIORITY_RE, '')
      .replace(SOURCE_BUCKET_RE, '')
      .replace(/^[\s—\-:]+|[\s—\-:]+$/g, '')
      .trim();

    if (description.length === 0) {
      warnings.push(`line ${lineNumber}: numbered row had no description after stripping metadata`);
      continue;
    }

    const anchor = anchorMatch?.[1] ?? null;
    const anchorUrl = anchorMatch?.[2] ?? null;
    items.push({
      id: deriveId({ anchorUrl, anchor, description }),
      anchor,
      anchor_url: anchorUrl,
      priority: priorityMatch?.[1] ?? null,
      description,
      source_bucket: sourceMatch?.[1] ?? null,
    });
  }

  const duplicates = findDuplicates(items);
  if (duplicates.length > 0) {
    return err(WalkErrors.duplicate(duplicates));
  }

  return ok({ items, warnings });
}

/**
 * Derive a stable 8-char id from item content. Precedence:
 * `anchor_url` (most stable) → `anchor` text → `description`. The
 * description fallback is always available because rows with empty
 * descriptions are filtered upstream.
 */
function deriveId({
  anchorUrl,
  anchor,
  description,
}: {
  anchorUrl: string | null;
  anchor: string | null;
  description: string;
}): string {
  const seed = anchorUrl ?? anchor ?? description;
  return createHash('sha1').update(seed).digest('hex').slice(0, 8);
}

/**
 * Find logically-duplicate items: same `anchor_url`, or same `anchor`
 * text when both items have no URL. Items without an anchor (URL or
 * text) are never duplicates of each other — they're identified only
 * by their description, which can legitimately repeat ("follow up on
 * the same topic in two different threads").
 */
function findDuplicates(items: ReadonlyArray<WalkItem>): ReadonlyArray<WalkItem> {
  const byUrl = new Map<string, WalkItem[]>();
  const byAnchor = new Map<string, WalkItem[]>();

  for (const item of items) {
    if (item.anchor_url != null) {
      const bucket = byUrl.get(item.anchor_url) ?? [];
      bucket.push(item);
      byUrl.set(item.anchor_url, bucket);
    } else if (item.anchor != null) {
      const bucket = byAnchor.get(item.anchor) ?? [];
      bucket.push(item);
      byAnchor.set(item.anchor, bucket);
    }
  }

  const duplicates: WalkItem[] = [];
  for (const bucket of byUrl.values()) {
    if (bucket.length > 1) duplicates.push(...bucket);
  }
  for (const bucket of byAnchor.values()) {
    if (bucket.length > 1) duplicates.push(...bucket);
  }
  return duplicates;
}
