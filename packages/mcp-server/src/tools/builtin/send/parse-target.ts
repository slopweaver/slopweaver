/**
 * Parser for the `target:` frontmatter field of a draft file. Accepts
 * a compact URI-style string and returns a discriminated union the
 * `prepare_send` tool consumes.
 *
 * Supported shapes:
 *
 *   slack:<channel_id>/thread:<ts>     → Slack reply in a thread
 *   slack:<channel_id>                  → Slack top-level message in a channel
 *   github:<owner>/<repo>/pull/<n>     → GitHub PR comment
 *   github:<owner>/<repo>/issue/<n>    → GitHub issue comment
 *   gmail:<thread_id>                   → Gmail reply
 *   linear:<issue_id>                   → Linear comment
 *
 * Pure function. Returns `null` if the target string doesn't match any
 * supported shape — the caller surfaces a typed error.
 */

export type ParsedTarget =
  | { readonly platform: 'slack'; readonly channel: string; readonly thread_ts?: string }
  | {
      readonly platform: 'github';
      readonly owner: string;
      readonly repo: string;
      readonly kind: 'pull' | 'issue';
      readonly number: number;
    }
  | { readonly platform: 'gmail'; readonly thread_id: string }
  | { readonly platform: 'linear'; readonly issue_id: string };

export function parseTarget(target: string): ParsedTarget | null {
  if (target.startsWith('slack:')) return parseSlackTarget(target);
  if (target.startsWith('github:')) return parseGithubTarget(target);
  if (target.startsWith('gmail:')) {
    const id = target.slice('gmail:'.length).trim();
    if (id.length === 0) return null;
    return { platform: 'gmail', thread_id: id };
  }
  if (target.startsWith('linear:')) {
    const id = target.slice('linear:'.length).trim();
    if (id.length === 0) return null;
    return { platform: 'linear', issue_id: id };
  }
  return null;
}

function parseSlackTarget(target: string): ParsedTarget | null {
  // slack:<channel>[/thread:<ts>]
  const body = target.slice('slack:'.length);
  const threadMarker = '/thread:';
  const threadIdx = body.indexOf(threadMarker);
  if (threadIdx === -1) {
    const channel = body.trim();
    if (channel.length === 0) return null;
    return { platform: 'slack', channel };
  }
  const channel = body.slice(0, threadIdx).trim();
  const threadTs = body.slice(threadIdx + threadMarker.length).trim();
  if (channel.length === 0 || threadTs.length === 0) return null;
  return { platform: 'slack', channel, thread_ts: threadTs };
}

function parseGithubTarget(target: string): ParsedTarget | null {
  // github:<owner>/<repo>/(pull|issue)/<number>
  const body = target.slice('github:'.length);
  const parts = body.split('/');
  if (parts.length !== 4) return null;
  const [owner, repo, kindRaw, numberRaw] = parts;
  if (owner == null || repo == null || kindRaw == null || numberRaw == null) return null;
  if (owner.length === 0 || repo.length === 0) return null;
  if (kindRaw !== 'pull' && kindRaw !== 'issue') return null;
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { platform: 'github', owner, repo, kind: kindRaw, number };
}
