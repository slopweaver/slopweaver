/**
 * Sentinel-driven test of the Slack PII redactors.
 *
 * Builds a representative recording (covering `auth.test`, `users.info`,
 * `search.messages`, `conversations.list`, `conversations.history`) where
 * every PII field is set to a unique sentinel string. Runs the redactors
 * against it and asserts no sentinel survives.
 *
 * If a future contributor adds a Slack response field with PII and forgets
 * to extend `redact-slack.ts`, this test fails before the cassette can be
 * recorded, let alone committed.
 */

import { describe, expect, it } from 'vitest';
import type { PollyRecording } from '@slopweaver/integrations-core/test-setup/polly';
import { slackRedactors } from './redact-slack.ts';

const SENTINELS = [
  '__SENTINEL_MESSAGE_TEXT__',
  '__SENTINEL_REAL_NAME__',
  '__SENTINEL_DISPLAY_NAME__',
  '__SENTINEL_DISPLAY_NORM__',
  '__SENTINEL_FIRST_NAME__',
  '__SENTINEL_LAST_NAME__',
  '__SENTINEL_EMAIL__',
  '__SENTINEL_PHONE__',
  '__SENTINEL_TITLE__',
  '__SENTINEL_TZ__',
  '__SENTINEL_TZ_LABEL__',
  '__SENTINEL_STATUS_TEXT__',
  '__SENTINEL_IMAGE_URL__',
  '__SENTINEL_CHANNEL_NAME__',
  '__SENTINEL_CHANNEL_NAME_NORM__',
  '__SENTINEL_PURPOSE__',
  '__SENTINEL_TOPIC__',
  '__SENTINEL_QUERY__',
  '__SENTINEL_AVATAR_HASH__',
  '__SENTINEL_USER_HANDLE__',
  '__SENTINEL_TEAM_NAME__',
  '__SENTINEL_USERNAME__',
  '__SENTINEL_FILE_ID__',
  '__SENTINEL_TAB_ID__',
  '__SENTINEL_SHARED_TS__',
];

function buildRecording(): PollyRecording {
  return {
    request: {
      url: 'https://slack.com/api/search.messages',
      headers: [{ name: 'authorization', value: 'Bearer xoxp-…' }],
      cookies: [],
      postData: { text: 'query=__SENTINEL_QUERY__&count=100&page=1' },
    },
    response: {
      headers: [],
      cookies: [],
      content: {
        text: JSON.stringify({
          ok: true,
          // auth.test url + ambiguous user/team strings
          url: 'https://slopweaver.slack.com/',
          team: '__SENTINEL_TEAM_NAME__',
          user: '__SENTINEL_USER_HANDLE__',
          team_id: 'T0',
          user_id: 'U0',
          // users.info shape
          user_obj_keep_user_id_intact: 'U0',
          full_user: {
            id: 'U0',
            name: 'login-handle',
            real_name: '__SENTINEL_REAL_NAME__',
            tz: '__SENTINEL_TZ__',
            tz_label: '__SENTINEL_TZ_LABEL__',
            avatar_hash: '__SENTINEL_AVATAR_HASH__',
            profile: {
              real_name: '__SENTINEL_REAL_NAME__',
              real_name_normalized: '__SENTINEL_REAL_NAME__',
              display_name: '__SENTINEL_DISPLAY_NAME__',
              display_name_normalized: '__SENTINEL_DISPLAY_NORM__',
              first_name: '__SENTINEL_FIRST_NAME__',
              last_name: '__SENTINEL_LAST_NAME__',
              email: '__SENTINEL_EMAIL__',
              phone: '__SENTINEL_PHONE__',
              title: '__SENTINEL_TITLE__',
              status_text: '__SENTINEL_STATUS_TEXT__',
              image_72: '__SENTINEL_IMAGE_URL__',
              image_512: '__SENTINEL_IMAGE_URL__',
              avatar_hash: '__SENTINEL_AVATAR_HASH__',
              // The 'team' field on a user profile is a team_id (Slack ID format)
              // — must NOT be scrubbed because tests assert on team_ids.
              team: 'T0',
            },
          },
          // search.messages
          messages: {
            matches: [
              {
                ts: '1.0',
                user: 'U0',
                username: '__SENTINEL_USERNAME__',
                text: '__SENTINEL_MESSAGE_TEXT__',
                channel: { id: 'C0', name: '__SENTINEL_CHANNEL_NAME__' },
                permalink: 'https://slopweaverworkspace.slack.com/archives/C0/p1000',
              },
            ],
            paging: { count: 1, total: 1, page: 1, pages: 1 },
          },
          // conversations.list
          channels: [
            {
              id: 'C0',
              is_im: false,
              name: '__SENTINEL_CHANNEL_NAME__',
              name_normalized: '__SENTINEL_CHANNEL_NAME_NORM__',
              purpose: { value: '__SENTINEL_PURPOSE__', creator: 'U0' },
              topic: { value: '__SENTINEL_TOPIC__', creator: 'U0' },
              // The `properties` subtree on a channel can contain references
              // to workspace-internal canvases, meeting-notes, tabs, file IDs.
              // Slack adds keys here over time. We drop the whole subtree
              // rather than enumerate.
              properties: {
                meeting_notes: { file_id: '__SENTINEL_FILE_ID__', is_locked: true },
                tabs: [
                  {
                    id: '__SENTINEL_TAB_ID__',
                    type: 'canvas',
                    data: {
                      file_id: '__SENTINEL_FILE_ID__',
                      shared_ts: '__SENTINEL_SHARED_TS__',
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    },
  };
}

describe('slack redactors', () => {
  it('strips every sentinel from a representative recording', () => {
    const recording = buildRecording();
    for (const redactor of slackRedactors) {
      redactor(recording);
    }
    const serialized =
      (recording.request?.postData?.text ?? '') + (recording.response?.content?.text ?? '');
    for (const sentinel of SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('preserves IDs and structural fields', () => {
    const recording = buildRecording();
    for (const redactor of slackRedactors) {
      redactor(recording);
    }
    const text = recording.response?.content?.text ?? '';
    expect(text).toContain('"id":"U0"');
    expect(text).toContain('"id":"C0"');
    expect(text).toContain('"ok":true');
    expect(text).toContain('"is_im":false');
    expect(text).toContain('"ts":"1.0"');
    expect(text).toContain('"team_id":"T0"');
    expect(text).toContain('"user_id":"U0"');
    // `team` inside profile is a team_id — pseudonymous, must survive.
    expect(text).toContain('"team":"T0"');
  });

  it('replaces workspace .slack.com URL with example.slack.com', () => {
    const recording = buildRecording();
    for (const redactor of slackRedactors) {
      redactor(recording);
    }
    const text = recording.response?.content?.text ?? '';
    expect(text).not.toContain('slopweaver.slack.com');
    expect(text).not.toContain('slopweaverworkspace.slack.com');
    expect(text).toContain('example.slack.com');
    // Permalink path structure preserved
    expect(text).toContain('example.slack.com/archives/C0/p1000');
  });

  it('replaces query and q form params with [redacted-query]', () => {
    const recording = buildRecording();
    for (const redactor of slackRedactors) {
      redactor(recording);
    }
    const body = recording.request?.postData?.text ?? '';
    expect(body).not.toContain('__SENTINEL_QUERY__');
    expect(body).toMatch(/query=%5Bredacted-query%5D/);
  });
});
