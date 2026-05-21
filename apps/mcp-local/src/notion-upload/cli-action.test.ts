import { describe, expect, it } from 'vitest';
import { resolveConfig, runNotionUploadImage } from './cli-action.ts';

describe('resolveConfig', () => {
  it('errors when no token_v2 is set', () => {
    const r = resolveConfig({ flags: { page: 'p', image: 'i' }, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('token_v2');
  });

  it('builds a default-host config from env only', () => {
    const r = resolveConfig({ flags: { page: 'p', image: 'i' }, env: { NOTION_TOKEN_V2: 'abc' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.tokenV2).toBe('abc');
      expect(r.config.apiBaseUrl).toBeUndefined();
      expect(r.config.userId).toBeUndefined();
    }
  });

  it('flag overrides env for token + base URL', () => {
    const r = resolveConfig({
      flags: { page: 'p', image: 'i', tokenV2: 'flag-token', workspaceUrl: 'https://example.com' },
      env: { NOTION_TOKEN_V2: 'env-token', SLOPWEAVER_NOTION_API_BASE: 'https://env.example' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.tokenV2).toBe('flag-token');
      expect(r.config.apiBaseUrl).toBe('https://example.com');
    }
  });

  it('treats an empty NOTION_USER_ID as unset', () => {
    const r = resolveConfig({
      flags: { page: 'p', image: 'i' },
      env: { NOTION_TOKEN_V2: 'abc', NOTION_USER_ID: '' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.userId).toBeUndefined();
  });
});

describe('runNotionUploadImage', () => {
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

  it('exits 2 + stderr when no token is configured', async () => {
    const { io, readStderr } = makeIo();
    const code = await runNotionUploadImage({ flags: { page: 'p', image: 'i' }, io });
    expect(code).toBe(2);
    expect(readStderr()).toContain('token_v2');
  });
});
