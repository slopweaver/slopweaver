/**
 * Unit tests for detectClients. Uses real fs against a per-test temp dir
 * keyed off `os.tmpdir()` + `mkdtemp` to avoid the overhead and footgun of
 * mocking node:fs/promises. The temp dir doubles as `home` so every config
 * path resolves under the sandbox. A second temp dir doubles as `cwd` so
 * the project-local Cursor probe has somewhere to look.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clineConfigPath, configPathFor, detectClients } from './detect-clients.ts';

describe('detectClients', () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'slopweaver-init-detect-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'slopweaver-init-detect-cwd-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeConfig({ path, contents }: { path: string; contents: string }): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf-8');
  }

  it('with empty home + cwd, reports three home-variant entries (no project-local cursor)', async () => {
    const results = await detectClients({ home, cwd, clineDir: undefined });
    // Three entries: claude-code/home, cursor/home, cline/home. The
    // project-local cursor entry is suppressed when the file doesn't exist.
    expect(results.map((r) => `${r.kind}:${r.variant}`)).toEqual(['claude-code:home', 'cursor:home', 'cline:home']);
    for (const r of results) {
      expect(r.exists).toBe(false);
      expect(r.hasSlopweaver).toBe(false);
    }
  });

  it('emits a project-local cursor entry when <cwd>/.cursor/mcp.json exists', async () => {
    await writeConfig({
      path: join(cwd, '.cursor', 'mcp.json'),
      contents: JSON.stringify({
        mcpServers: { slopweaver: { command: 'npx', args: ['-y', '@slopweaver/mcp-local'] } },
      }),
    });

    const results = await detectClients({ home, cwd, clineDir: undefined });
    const projectCursor = results.find((r) => r.kind === 'cursor' && r.variant === 'project');
    expect(projectCursor).toBeDefined();
    expect(projectCursor?.configPath).toBe(join(cwd, '.cursor', 'mcp.json'));
    expect(projectCursor?.exists).toBe(true);
    expect(projectCursor?.hasSlopweaver).toBe(true);
  });

  it('emits both home and project cursor entries when both exist', async () => {
    await writeConfig({
      path: join(home, '.cursor', 'mcp.json'),
      contents: JSON.stringify({ mcpServers: {} }),
    });
    await writeConfig({
      path: join(cwd, '.cursor', 'mcp.json'),
      contents: JSON.stringify({
        mcpServers: { slopweaver: { command: 'npx' } },
      }),
    });

    const results = await detectClients({ home, cwd, clineDir: undefined });
    const cursorEntries = results.filter((r) => r.kind === 'cursor');
    expect(cursorEntries.map((r) => r.variant)).toEqual(['home', 'project']);
    expect(cursorEntries[0]?.hasSlopweaver).toBe(false);
    expect(cursorEntries[1]?.hasSlopweaver).toBe(true);
  });

  it('uses $CLINE_DIR for the cline path when provided, marked as env-override', async () => {
    const customClineDir = await mkdtemp(join(tmpdir(), 'slopweaver-init-cline-'));
    try {
      const path = clineConfigPath({ home, clineDir: customClineDir });
      await writeConfig({
        path,
        contents: JSON.stringify({ mcpServers: { slopweaver: { command: 'npx' } } }),
      });

      const results = await detectClients({ home, cwd, clineDir: customClineDir });
      const cline = results.find((r) => r.kind === 'cline');
      expect(cline?.variant).toBe('env-override');
      expect(cline?.configPath).toBe(path);
      expect(cline?.exists).toBe(true);
      expect(cline?.hasSlopweaver).toBe(true);
      // Sanity: the env-override path is NOT under $HOME.
      expect(cline?.configPath.startsWith(home)).toBe(false);
    } finally {
      await rm(customClineDir, { recursive: true, force: true });
    }
  });

  it('reports exists: true, hasSlopweaver: false when ~/.claude.json has no mcpServers key', async () => {
    await writeConfig({
      path: configPathFor({ kind: 'claude-code', home }),
      contents: JSON.stringify({ model: 'claude-opus-4-7' }),
    });

    const results = await detectClients({ home, cwd, clineDir: undefined });
    const claude = results.find((r) => r.kind === 'claude-code');
    expect(claude).toMatchObject({
      kind: 'claude-code',
      variant: 'home',
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

    const results = await detectClients({ home, cwd, clineDir: undefined });
    const cursor = results.find((r) => r.kind === 'cursor' && r.variant === 'home');
    expect(cursor).toMatchObject({
      kind: 'cursor',
      variant: 'home',
      configPath: configPathFor({ kind: 'cursor', home }),
      exists: true,
      hasSlopweaver: true,
    });
  });

  it('reports hasSlopweaver: false (no throw) when the cline config is malformed JSON', async () => {
    await writeConfig({
      path: configPathFor({ kind: 'cline', home }),
      contents: '{ this is not valid json',
    });

    const results = await detectClients({ home, cwd, clineDir: undefined });
    const cline = results.find((r) => r.kind === 'cline');
    expect(cline).toMatchObject({
      kind: 'cline',
      variant: 'home',
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

    const results = await detectClients({ home, cwd, clineDir: undefined });
    const cursor = results.find((r) => r.kind === 'cursor' && r.variant === 'home');
    expect(cursor?.hasSlopweaver).toBe(true);
  });
});
