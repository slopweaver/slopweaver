import { describe, expect, it } from 'vitest';
import { collectPollyDiagnosticStrings, isAllowedRecordingPath, scanRecordingHar } from './core.ts';

const goodHar: Record<string, unknown> = {
  log: {
    entries: [
      {
        request: { url: 'https://slack.com/api/auth.test' },
        response: {
          status: 200,
          content: { text: JSON.stringify({ ok: true, user_id: 'U1', team_id: 'T1' }) },
        },
      },
    ],
  },
};

const expiredTokenHar: Record<string, unknown> = {
  log: {
    entries: [
      {
        request: { url: 'https://slack.com/api/search.messages' },
        response: {
          status: 401,
          content: {
            text: JSON.stringify({ ok: false, error: 'invalid_auth', message: 'token expired' }),
          },
        },
      },
    ],
  },
};

const polly404Har: Record<string, unknown> = {
  log: {
    entries: [
      {
        request: { url: 'https://example.com/api/foo' },
        response: {
          status: 200,
          content: {
            text: '[polly] [adapter:node-http] recording for the following request is not found',
          },
        },
      },
    ],
  },
};

describe('isAllowedRecordingPath', () => {
  it('allows paths under /auth/', () => {
    expect(
      isAllowedRecordingPath({
        relPath: 'packages/integrations/slack/src/__recordings__/auth/test/recording.har',
      }),
    ).toBe(true);
  });

  it('allows paths containing "refresh"', () => {
    expect(isAllowedRecordingPath({ relPath: 'foo/refresh-token/recording.har' })).toBe(true);
  });

  it('rejects paths without an allowlist keyword', () => {
    expect(isAllowedRecordingPath({ relPath: 'foo/happy/path/recording.har' })).toBe(false);
  });
});

describe('collectPollyDiagnosticStrings', () => {
  it('collects strings from diagnostic field names', () => {
    const result = collectPollyDiagnosticStrings({
      value: { error: 'oops', message: 'broken', irrelevant: 'ignored' },
    });
    expect(result.sort()).toEqual(['broken', 'oops']);
  });

  it('recurses into nested diagnostic fields', () => {
    const result = collectPollyDiagnosticStrings({
      value: { errors: [{ message: 'first' }, { message: 'second' }] },
    });
    expect(result).toEqual(['first', 'second']);
  });

  it('ignores non-diagnostic keys even at the top level', () => {
    expect(collectPollyDiagnosticStrings({ value: { foo: 'bar' } })).toEqual([]);
  });
});

describe('scanRecordingHar', () => {
  it('returns no violations for a clean happy-path cassette', () => {
    expect(scanRecordingHar({ content: goodHar, relPath: 'a/b/happy/recording.har' })).toEqual([]);
  });

  it('flags an expired-token cassette outside an allowlist path', () => {
    const violations = scanRecordingHar({
      content: expiredTokenHar,
      relPath: 'packages/integrations/slack/src/__recordings__/poll-mentions/happy/recording.har',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toContain('status=401');
    expect(violations[0]?.text).toContain('token expired');
  });

  it('does NOT flag the same expired-token cassette under an allowlist path', () => {
    const violations = scanRecordingHar({
      content: expiredTokenHar,
      relPath: 'packages/integrations/slack/src/__recordings__/auth/expired/recording.har',
    });
    expect(violations).toEqual([]);
  });

  it('flags Polly missing-recording bodies', () => {
    const violations = scanRecordingHar({
      content: polly404Har,
      relPath: 'packages/integrations/github/src/__recordings__/poll-mentions/case/recording.har',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toContain('recording for the following request is not found');
  });

  it('returns empty for a HAR with zero entries', () => {
    const empty: Record<string, unknown> = { log: { entries: [] } };
    expect(scanRecordingHar({ content: empty, relPath: 'a/happy/recording.har' })).toEqual([]);
  });
});
