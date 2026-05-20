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
 */

export type WalkItem = {
  readonly index: number;
  readonly anchor: string | null;
  readonly anchor_url: string | null;
  readonly priority: string | null;
  readonly description: string;
  readonly source_bucket: string | null;
};

const SECTION_HEADING = /^##\s+walk order/i;
const NEXT_HEADING = /^##\s+/;
const NUMBERED_LINE = /^\s*\d+\./;
const ANCHOR_RE = /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/;
const PRIORITY_RE = /`\[([^\]]+)\]`/;
const SOURCE_BUCKET_RE = /\*\(([^)]+)\)\*\s*$/;

export function parseWalkOrder(markdown: string): ReadonlyArray<WalkItem> {
  const lines = markdown.split('\n');
  const items: WalkItem[] = [];
  let inSection = false;

  for (const line of lines) {
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

    items.push({
      index: items.length + 1,
      anchor: anchorMatch?.[1] ?? null,
      anchor_url: anchorMatch?.[2] ?? null,
      priority: priorityMatch?.[1] ?? null,
      description,
      source_bucket: sourceMatch?.[1] ?? null,
    });
  }

  return items;
}
