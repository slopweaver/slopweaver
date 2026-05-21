import { describe, expect, it } from 'vitest';
import { resolveConfig, runSlackSendImage } from './cli-action.ts';

describe('resolveConfig', () => {
  it('errors when neither --xoxc nor SLACK_XOXC is set', () => {
    const r = resolveConfig({
      flags: { channel: 'C0', text: 't', image: 'p' },
      env: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('xoxc');
  });

  it('errors when no workspace URL is set', () => {
    const r = resolveConfig({
      flags: { channel: 'C0', text: 't', image: 'p', xoxc: 'xoxc-fake' },
      env: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('workspace');
  });

  it('builds a standard-workspace config from env', () => {
    const r = resolveConfig({
      flags: { channel: 'C0', text: 't', image: 'p' },
      env: { SLACK_XOXC: 'xoxc-fake', SLOPWEAVER_SLACK_WORKSPACE_URL: 'https://acme.slack.com' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.apiBaseUrl).toBe('https://acme.slack.com');
      expect(r.config.token).toBe('xoxc-fake');
      expect(r.config.slackRoute).toBeUndefined();
    }
  });

  it('includes slackRoute when env supplies it', () => {
    const r = resolveConfig({
      flags: { channel: 'C0', text: 't', image: 'p' },
      env: {
        SLACK_XOXC: 'xoxc-fake',
        SLOPWEAVER_SLACK_WORKSPACE_URL: 'https://acme.enterprise.slack.com',
        SLOPWEAVER_SLACK_ROUTE: 'E0:T1',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.slackRoute).toBe('E0:T1');
  });

  it('flag overrides env', () => {
    const r = resolveConfig({
      flags: { channel: 'C0', text: 't', image: 'p', xoxc: 'xoxc-from-flag' },
      env: { SLACK_XOXC: 'xoxc-from-env', SLOPWEAVER_SLACK_WORKSPACE_URL: 'https://acme.slack.com' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.token).toBe('xoxc-from-flag');
  });

  it('treats an empty SLOPWEAVER_SLACK_ROUTE as unset', () => {
    const r = resolveConfig({
      flags: { channel: 'C0', text: 't', image: 'p' },
      env: {
        SLACK_XOXC: 'xoxc-fake',
        SLOPWEAVER_SLACK_WORKSPACE_URL: 'https://acme.slack.com',
        SLOPWEAVER_SLACK_ROUTE: '',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.slackRoute).toBeUndefined();
  });
});

describe('runSlackSendImage', () => {
  function makeIo() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: { write: (s: string) => stdout.push(s) },
        stderr: { write: (s: string) => stderr.push(s) },
        env: {} as Record<string, string | undefined>,
      },
      readStdout: () => stdout.join(''),
      readStderr: () => stderr.join(''),
    };
  }

  it('returns exit code 2 + stderr when no token is configured', async () => {
    const { io, readStderr, readStdout } = makeIo();
    const code = await runSlackSendImage({
      flags: { channel: 'C0', text: 't', image: 'p' },
      io,
    });
    expect(code).toBe(2);
    expect(readStderr()).toContain('xoxc');
    expect(readStdout()).toBe('');
  });

  it('returns exit code 2 + stderr when no workspace URL is configured', async () => {
    const { io, readStderr } = makeIo();
    const code = await runSlackSendImage({
      flags: { channel: 'C0', text: 't', image: 'p', xoxc: 'xoxc-fake' },
      io,
    });
    expect(code).toBe(2);
    expect(readStderr()).toContain('workspace');
  });
});
