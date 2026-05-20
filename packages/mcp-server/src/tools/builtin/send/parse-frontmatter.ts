/**
 * Tiny YAML-frontmatter parser. Drafts under `.claude/personal/drafts/`
 * follow a fixed shape: `--- key: value\nkey: value ---\n<body>`. We
 * intentionally don't pull in `yaml` for this — the surface is small,
 * deterministic, and we want zero deps for the send pipeline.
 *
 * Supports: top-level string values only. No nested objects, no
 * arrays, no quoting. The `target:` and `draft_id:` fields are the
 * only ones currently consumed.
 */

export type ParsedDraft = {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
};

export function parseFrontmatter(input: string): ParsedDraft | null {
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
