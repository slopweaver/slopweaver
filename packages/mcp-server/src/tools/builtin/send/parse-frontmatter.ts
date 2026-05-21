/**
 * Tiny YAML-frontmatter parser. Drafts under `.claude/personal/drafts/`
 * follow a fixed shape: `--- key: value\nkey: value ---\n<body>`. We
 * intentionally don't pull in `yaml` for this — the surface is small,
 * deterministic, and we want zero deps for the send pipeline.
 *
 * Supports: top-level string values only. No nested objects, no
 * arrays, no quoting. The `target:`, `draft_id:`, and `status:` fields
 * are the only ones consumed today.
 */

import { createHash } from 'node:crypto';

export type ParsedDraft = {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
};

export function parseFrontmatter({ input }: { input: string }): ParsedDraft | null {
  if (!input.startsWith('---\n') && !input.startsWith('---\r\n')) {
    return null;
  }
  const afterOpen = input.indexOf('\n') + 1;
  const closeIdx = input.indexOf('\n---', afterOpen);
  if (closeIdx === -1) return null;
  const fmBlock = input.slice(afterOpen, closeIdx);
  const bodyStart = input.indexOf('\n', closeIdx + 4);
  const body = bodyStart === -1 ? '' : input.slice(bodyStart + 1);
  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key.length === 0) continue;
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

/**
 * Stable, order-independent hash of a frontmatter record. Keys are
 * sorted before hashing so adding/removing the `status:` field (which
 * `record_send_outcome` rewrites) doesn't perturb it — the hash
 * intentionally excludes `status` so the model can be told "this hash
 * pins the draft target+body+id between prepare_send and
 * record_send_outcome" without having to re-issue the hash on every
 * status transition.
 */
export function hashFrontmatter({ frontmatter }: { frontmatter: Readonly<Record<string, string>> }): string {
  const entries = Object.entries(frontmatter)
    .filter(([k]) => k !== 'status')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return createHash('sha256').update(entries, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * Serialise a frontmatter record back into the `---\n<lines>\n---\n<body>`
 * shape this parser consumes. Used by `record_send_outcome` to rewrite
 * the `status:` field while preserving every other key and the body.
 * Keys are emitted in sorted order to keep the output deterministic
 * (mirrors `hashFrontmatter`'s sort).
 */
export function serializeDraft({
  frontmatter,
  body,
}: {
  frontmatter: Readonly<Record<string, string>>;
  body: string;
}): string {
  const sortedEntries = Object.entries(frontmatter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fmLines = sortedEntries.map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${fmLines}\n---\n${body}`;
}
