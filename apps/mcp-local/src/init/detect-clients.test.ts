/**
 * Unit tests for detectClients. Uses real fs against a per-test temp dir
 * keyed off `os.tmpdir()` + `mkdtemp` to avoid the overhead and footgun of
 * mocking node:fs/promises. The temp dir doubles as `home` so every config
 * path resolves under the sandbox.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPathFor, detectClients } from './detect-clients.ts';

describe('detectClients', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'slopweaver-init-detect-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig({
    path,
    contents,
  }: {
    path: string;
    contents: string;
  }): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf-8');
  }

  it('reports exists: false, hasSlopweaver: false for every client when home is empty', async () => {
    const results = await detectClients({ home });
    expect(results.map((r) => r.kind)).toEqual(['claude-code', 'cursor', 'cline']);
    for (const r of results) {
      expect(r.exists).toBe(false);
      expect(r.hasSlopweaver).toBe(false);
    }
  });

  it('returns the canonical config paths under the provided home', async () => {
    const results = await detectClients({ home });
    expect(results[0]!.configPath).toBe(configPathFor({ kind: 'claude-code', home }));
    expect(results[1]!.configPath).toBe(configPathFor({ kind: 'cursor', home }));
    expect(results[2]!.configPath).toBe(configPathFor({ kind: 'cline', home }));
    // Smoke-check the actual on-disk paths so a future rename to e.g.
    // `~/.config/cline/...` would fail this test loudly.
    expect(results[0]!.configPath).toMatch(/\.claude\.json$/);
    expect(results[1]!.configPath).toMatch(/\.cursor\/mcp\.json$/);
    expect(results[2]!.configPath).toMatch(/\.cline\/data\/settings\/cline_mcp_settings\.json$/);
  });

  it('reports exists: true, hasSlopweaver: false when ~/.claude.json has no mcpServers key', async () => {
    await writeConfig({
      path: configPathFor({ kind: 'claude-code', home }),
      contents: JSON.stringify({ model: 'claude-opus-4-7' }),
    });

    const [claude] = await detectClients({ home });
    expect(claude).toEqual({
      kind: 'claude-code',
      configPath: configPathFor({ kind: 'claude-code', home }),
      exists: true,
      hasSlopweaver: false,
    });
  });

  it('reports hasSlopweaver: true when ~/.cursor/mcp.json contains a slopweaver entry', async () => {
    await writeConfig({
      path: configPathFor({ kind: 'cursor', home }),
      contents: JSON.stringify({
        mcpServers: {
          slopweaver: { command: 'npx', args: ['-y', '@slopweaver/mcp-local'] },
        },
      }),
    });

    const results = await detectClients({ home });
    const cursor = results.find((r) => r.kind === 'cursor');
    expect(cursor).toEqual({
      kind: 'cursor',
      configPath: configPathFor({ kind: 'cursor', home }),
      exists: true,
      hasSlopweaver: true,
    });
  });

  it('reports hasSlopweaver: false (no throw) when ~/.cline/... is malformed JSON', async () => {
    await writeConfig({
      path: configPathFor({ kind: 'cline', home }),
      contents: '{ this is not valid json',
    });

    const results = await detectClients({ home });
    const cline = results.find((r) => r.kind === 'cline');
    expect(cline).toEqual({
      kind: 'cline',
      configPath: configPathFor({ kind: 'cline', home }),
      exists: true,
      hasSlopweaver: false,
    });
  });

  it('reports hasSlopweaver: true when slopweaver is one of several entries', async () => {
    await writeConfig({
      path: configPathFor({ kind: 'cursor', home }),
      contents: JSON.stringify({
        mcpServers: {
          someOther: { command: 'node', args: ['./other.js'] },
          slopweaver: { command: 'slopweaver' },
        },
      }),
    });

    const results = await detectClients({ home });
    const cursor = results.find((r) => r.kind === 'cursor');
    expect(cursor?.hasSlopweaver).toBe(true);
  });
});
