/**
 * `/api/companion/file` POST endpoint backend. Accepts a JSON payload
 * `{ url, title }` from the Chrome companion (see
 * `packages/companion-chrome/`) and appends a JSONL line to
 * `<cwd>/.claude/personal/state/companion-inbox.jsonl`.
 *
 * The endpoint is loopback-bound + Origin-validated by the existing
 * UI server's same-origin guard. The companion's manifest declares
 * `127.0.0.1:60701` as a host permission so the browser sends the
 * matching Origin header.
 *
 * Pure-ish: parses JSON, writes a JSONL line. No fancy work-file
 * routing in v1.1 first cut — every entry lands in a single inbox
 * JSONL, the user (or `/session-start`) routes them to the right
 * work file later.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const INBOX_REL_PATH = '.claude/personal/state/companion-inbox.jsonl';

export type CompanionFileResult = {
  filed: true;
  path: string;
  line_number: number;
};

export type CompanionFileError = {
  filed: false;
  error: string;
};

export type BuildCompanionFileArgs = {
  cwd: string;
  payload: unknown;
  nowMs?: number;
};

export async function buildCompanionFileResponse(
  args: BuildCompanionFileArgs,
): Promise<CompanionFileResult | CompanionFileError> {
  const validation = validatePayload(args.payload);
  if (!validation.valid) {
    return { filed: false, error: validation.error };
  }
  const nowMs = args.nowMs ?? Date.now();
  const logPath = join(args.cwd, INBOX_REL_PATH);
  const line = `${JSON.stringify({
    ts: new Date(nowMs).toISOString(),
    url: validation.url,
    title: validation.title,
  })}\n`;

  // Count existing lines so we can report the 1-based line number.
  let existing = 0;
  try {
    const content = await readFile(logPath, 'utf-8');
    existing = content.split('\n').filter((l) => l.trim().length > 0).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { filed: false, error: `failed to read inbox: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  try {
    await mkdir(dirname(logPath), { recursive: true });
  } catch (e) {
    return { filed: false, error: `failed to mkdir: ${e instanceof Error ? e.message : String(e)}` };
  }
  let next = line;
  try {
    const prev = await readFile(logPath, 'utf-8');
    next = prev.endsWith('\n') || prev.length === 0 ? `${prev}${line}` : `${prev}\n${line}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { filed: false, error: `failed to read inbox: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  try {
    await writeFile(logPath, next, { encoding: 'utf-8', mode: 0o644 });
  } catch (e) {
    return { filed: false, error: `failed to write inbox: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { filed: true, path: logPath, line_number: existing + 1 };
}

type Validated = { valid: true; url: string; title: string } | { valid: false; error: string };

/** Hard caps on payload sizes. URL spec doesn't bound length, but most
 * browsers + servers choke past ~2 KiB; titles ditto past ~512 chars.
 * Larger values are almost always a bug or an exfiltration attempt. */
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 512;

function validatePayload(payload: unknown): Validated {
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, error: 'payload must be a JSON object' };
  }
  const obj = payload as Record<string, unknown>;
  const url = obj['url'];
  const title = obj['title'];
  if (typeof url !== 'string' || url.length === 0) {
    return { valid: false, error: 'url must be a non-empty string' };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { valid: false, error: `url exceeds ${MAX_URL_LENGTH} characters` };
  }
  if (typeof title !== 'string') {
    return { valid: false, error: 'title must be a string' };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `title exceeds ${MAX_TITLE_LENGTH} characters` };
  }
  // Restrict to http(s) — `javascript:`, `data:`, `file:` and friends
  // would let an attacker land an arbitrary scheme into the inbox file
  // that a downstream tool might later open / render.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'url is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `url scheme must be http(s), got "${parsed.protocol}"` };
  }
  return { valid: true, url, title };
}
