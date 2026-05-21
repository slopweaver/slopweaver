/**
 * Pure-function renderer for the walk queue. Takes a list of WalkItems
 * and returns the multi-line string to print to stdout.
 *
 * Kept separate from the IO loop so tests can pin the exact output
 * shape without spawning a process. The interactive loop (a v1.2
 * follow-up using `ink` or `node:readline`) consumes the same data
 * structure.
 *
 * Display numbering (1-based) is derived here from the array index —
 * it's a presentation concern, not a property of the parsed model.
 */

import type { WalkItem } from './parse-walk-order.ts';

export function renderWalkQueue(items: ReadonlyArray<WalkItem>): string {
  if (items.length === 0) {
    return [
      'slopweaver walk',
      '',
      'No items in the walk queue.',
      '',
      'Run `/reconcile` (or `/session-start`) to populate',
      '`.claude/personal/state/reconciliation.md` with a `## Walk order`',
      'section, then re-run `slopweaver walk`.',
      '',
    ].join('\n');
  }

  const totalDigits = String(items.length).length;
  const lines: string[] = [];
  lines.push('slopweaver walk');
  lines.push('');
  lines.push(`Walking ${items.length} item(s). Per-item actions in /lock-in:`);
  lines.push('  do | agent | handoff | defer | skip | note | open-question | jump N');
  lines.push('');
  lines.push('(Interactive loop ships in a follow-up PR — for now this is read-only.)');
  lines.push('');

  for (const [index, item] of items.entries()) {
    const displayIndex = index + 1;
    const anchorBit = item.anchor != null ? `[${item.anchor}] ` : '';
    const priorityBit = item.priority != null ? `\`${item.priority}\` ` : '';
    const sourceBit = item.source_bucket != null ? ` (${item.source_bucket})` : '';
    lines.push(
      `${pad({ n: displayIndex, width: totalDigits })}. ${anchorBit}${priorityBit}${item.description}${sourceBit}`,
    );
    if (item.anchor_url != null) {
      lines.push(`    ${item.anchor_url}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function pad({ n, width }: { n: number; width: number }): string {
  return String(n).padStart(width, ' ');
}
