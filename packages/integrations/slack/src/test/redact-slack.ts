/**
 * Slack-specific PII redactors plugged into the core Polly setup.
 *
 * Strategy: keep IDs (pseudonymous, required for assertions), scrub everything
 * a determined adversary could correlate back to a real workspace or its
 * members. Applied at `beforePersist`, after the core's default
 * header/cookie/token-string redaction.
 *
 * Fields scrubbed:
 *   - message text (across `messages.matches[].text`, `messages[].text`,
 *     and any nested `attachments[].text` / `blocks[].elements[].text`)
 *   - user profile (`real_name`, `display_name`, `display_name_normalized`,
 *     `real_name_normalized`, `first_name`, `last_name`, `email`, `phone`,
 *     `title`, `image_*`, `bot_id`, `tz_label`)
 *   - channel name (`name`, `name_normalized`, `purpose.value`, `topic.value`)
 *   - workspace URL (`auth.test.url` → `https://example.slack.com/`)
 *
 * Fields preserved (pseudonymous):
 *   - All IDs: user_id (`U…`), channel_id (`C…`/`D…`/`G…`), team_id (`T…`),
 *     message ts (epoch), enterprise_id, app_id, bot_id-as-id-only.
 *   - Structural flags (`ok`, `is_im`, `is_member`, `is_bot`, `deleted`).
 *
 * Each redactor mutates the recording in place. The accompanying
 * `redact-slack.test.ts` exercises every redactor against a sentinel-laden
 * fixture and asserts no sentinel survives.
 */

import type { ExtraRedactor, PollyRecording } from '@slopweaver/integrations-core/test-setup/polly';

const SCRUB_PROFILE_KEYS = new Set([
  'real_name',
  'display_name',
  'display_name_normalized',
  'real_name_normalized',
  'first_name',
  'last_name',
  'email',
  'phone',
  'title',
  'tz',
  'tz_label',
  'status_text',
  'status_emoji',
  'status_emoji_display_info',
  'avatar_hash',
  'color',
  'who_can_share_contact_card',
  'username',
]);

// Any URL whose host ends in `.slack.com` reveals the workspace's vanity
// domain. Replace the host portion with `example.slack.com` and preserve
// the path (channel IDs are pseudonymous and tests assert on the structure).
const SLACK_HOST_REGEX = /https?:\/\/[a-z0-9-]+\.slack\.com/gi;

const SCRUB_IMAGE_KEY_REGEX = /^image_/;
const SCRUB_CHANNEL_KEYS = new Set(['name', 'name_normalized']);
const SCRUB_NESTED_TEXT_PARENTS = new Set(['purpose', 'topic']);
// `properties` on a Slack channel is an unstable, feature-flag-shaped subtree
// that holds references to workspace-internal canvases, meeting notes, file
// IDs, tab IDs, and other document metadata. We don't assert on any of it, so
// drop the entire subtree wholesale rather than enumerate every field Slack
// might add later.
const DROP_SUBTREE_KEYS = new Set(['properties']);
// `user` and `team` are tricky: they're used both as IDs (uppercase alnum,
// pseudonymous, must keep for assertions) and as handles / display names
// (PII, must scrub). The regex below matches Slack's ID format. Only scrub
// when the value doesn't look like an ID.
const SLACK_ID_REGEX = /^[UTCDGW][A-Z0-9]+$/;
const SCRUB_AMBIGUOUS_KEYS = new Set(['user', 'team']);

const REDACTED = '[redacted]';
const REDACTED_TEXT = '[redacted-message-text]';
const REDACTED_URL = 'https://example.slack.com/';

/**
 * Walk a JSON tree and apply Slack-specific scrubbers in place.
 *
 * The traversal is structural — it knows about Slack's response shapes well
 * enough to scrub at the right places without nuking IDs. A pure-text-blast
 * approach would either over-redact (lose `ok` / IDs) or under-redact (miss
 * nested attachments / blocks).
 */
function scrubSlackTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => scrubSlackTree(entry));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (DROP_SUBTREE_KEYS.has(key)) {
        out[key] = '[redacted]';
        continue;
      }
      if (key === 'text' && typeof v === 'string' && v.length > 0) {
        out[key] = REDACTED_TEXT;
        continue;
      }
      // Scrub any string value containing a *.slack.com URL (covers `url`,
      // `permalink`, and any other URL-shaped field). The replacement keeps
      // the URL structure (path, query) intact so tests can still assert on
      // it; only the workspace-identifying host is rewritten.
      if (typeof v === 'string' && SLACK_HOST_REGEX.test(v)) {
        SLACK_HOST_REGEX.lastIndex = 0;
        out[key] = v.replace(SLACK_HOST_REGEX, 'https://example.slack.com');
        SLACK_HOST_REGEX.lastIndex = 0;
        continue;
      }
      if (SCRUB_PROFILE_KEYS.has(key) && typeof v === 'string') {
        out[key] = REDACTED;
        continue;
      }
      if (SCRUB_AMBIGUOUS_KEYS.has(key) && typeof v === 'string') {
        out[key] = SLACK_ID_REGEX.test(v) ? v : REDACTED;
        continue;
      }
      if (SCRUB_IMAGE_KEY_REGEX.test(key) && typeof v === 'string') {
        out[key] = REDACTED;
        continue;
      }
      if (SCRUB_CHANNEL_KEYS.has(key) && typeof v === 'string') {
        out[key] = REDACTED;
        continue;
      }
      if (SCRUB_NESTED_TEXT_PARENTS.has(key) && v && typeof v === 'object') {
        const inner = v as Record<string, unknown>;
        out[key] = {
          ...inner,
          ...(typeof inner['value'] === 'string' && inner['value'].length > 0
            ? { value: REDACTED }
            : {}),
        };
        continue;
      }
      out[key] = scrubSlackTree(v);
    }
    return out;
  }
  return value;
}

const redactSlackResponse: ExtraRedactor = (recording: PollyRecording): void => {
  const text = recording.response?.content?.text;
  if (typeof text !== 'string' || text.length === 0) return;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const scrubbed = scrubSlackTree(parsed);
  if (recording.response?.content) {
    recording.response.content.text = JSON.stringify(scrubbed);
  }
};

const redactSlackRequestBody: ExtraRedactor = (recording: PollyRecording): void => {
  // search.messages and conversations.* requests are POST'd as form-urlencoded
  // bodies. Token values are already scrubbed by core's REDACT_VALUE_REGEX,
  // but `query=<@U…>` strings are also worth normalising — they reveal who
  // the recording user is. Replace any `query` param value entirely.
  const body = recording.request?.postData?.text;
  if (typeof body !== 'string' || body.length === 0) return;
  if (!body.includes('=')) return;
  try {
    const params = new URLSearchParams(body);
    let changed = false;
    for (const key of ['query', 'q']) {
      if (params.has(key)) {
        params.set(key, '[redacted-query]');
        changed = true;
      }
    }
    if (changed && recording.request?.postData) {
      recording.request.postData.text = params.toString();
    }
  } catch {
    // body wasn't urlencoded — leave it alone
  }
};

export const slackRedactors: ExtraRedactor[] = [redactSlackResponse, redactSlackRequestBody];
