/**
 * Pure append of voice-rule directives to a markdown rules body.
 *
 * Strategy:
 * - If the body already contains a `## Hard rules` section, append the
 *   new directives at the end of that section (just before the next
 *   `## ` heading, or EOF).
 * - If the body does not contain `## Hard rules`, append a fresh
 *   `## Hard rules` section at the end of the body.
 * - If a given directive's formatted form is already present in the
 *   body, skip it (idempotent for duplicate corrections).
 *
 * Returns the updated body plus the set of directives that were
 * actually applied (so callers can report "0 added" when everything
 * was a duplicate).
 */

import { formatDirective } from './format.ts';
import type { VoiceDirective } from './types.ts';

const HARD_RULES_HEADING = '## Hard rules';

export type AppendResult = {
  readonly updated: string;
  readonly added: ReadonlyArray<VoiceDirective>;
  readonly skipped: ReadonlyArray<VoiceDirective>;
};

export function appendDirectives({
  body,
  directives,
}: {
  body: string;
  directives: ReadonlyArray<VoiceDirective>;
}): AppendResult {
  const existingLines = new Set(body.split(/\r?\n/));
  const added: VoiceDirective[] = [];
  const skipped: VoiceDirective[] = [];
  const toAdd: string[] = [];
  for (const directive of directives) {
    const line = formatDirective({ directive });
    if (existingLines.has(line)) {
      skipped.push(directive);
      continue;
    }
    existingLines.add(line);
    added.push(directive);
    toAdd.push(line);
  }
  if (toAdd.length === 0) {
    return { updated: body, added, skipped };
  }

  const headingIndex = body.indexOf(HARD_RULES_HEADING);
  if (headingIndex === -1) {
    const trimmed = body.replace(/\s+$/, '');
    const sep = trimmed.length === 0 ? '' : '\n\n';
    const updated = `${trimmed}${sep}${HARD_RULES_HEADING}\n\n${toAdd.join('\n')}\n`;
    return { updated, added, skipped };
  }

  return { updated: insertAfterHardRulesSection({ body, headingIndex, toAdd }), added, skipped };
}

function insertAfterHardRulesSection({
  body,
  headingIndex,
  toAdd,
}: {
  body: string;
  headingIndex: number;
  toAdd: ReadonlyArray<string>;
}): string {
  // Find the next top-level (`## `) heading after the Hard rules
  // section. Insertion goes immediately before it, separated by a
  // single blank line. If no later heading exists, append before EOF.
  const sectionStart = headingIndex + HARD_RULES_HEADING.length;
  const nextHeadingMatch = /\n## /.exec(body.slice(sectionStart));
  const sectionEnd = nextHeadingMatch === null ? body.length : sectionStart + nextHeadingMatch.index;
  const head = body.slice(0, sectionEnd).replace(/\s+$/, '');
  const tail = body.slice(sectionEnd);
  const joined = toAdd.join('\n');
  if (tail.length === 0) {
    return `${head}\n${joined}\n`;
  }
  return `${head}\n${joined}\n\n${tail.replace(/^\n+/, '')}`;
}
