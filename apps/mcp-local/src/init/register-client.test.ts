/**
 * Unit tests for registerClient. Real fs against a per-test temp dir; fake
 * `exec` so we can simulate `claude mcp add` success, ENOENT, and non-zero
 * exits without spawning a real subprocess. This mirrors the `runConnect*`
 * test pattern: inject the side-effectful collaborators, exercise the
 * function, assert on observable state (file contents + exec call shape).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecImpl } from './register-client.ts';
import { registerClient } from './register-client.ts';

function fakeExec(result: Awaited<ReturnType<ExecImpl>>): ExecImpl {
  return vi.fn().mockResolvedValue(result);
}

describe('registerClient', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'slopweaver-init-register-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  describe('claude-code', () => {
    it('returns Ok after `claude mcp add` succeeds and does NOT write the config file', async () => {
      const configPath = join(home, '.claude.json');
      const exec = fakeExec({ kind: 'ok', exitCode: 0, stdout: '', stderr: '' });

      const result = await registerClient({
        kind: 'claude-code',
        configPath,
        exec,
      });

      expect(result.isOk()).toBe(true);
      expect(exec).toHaveBeenCalledWith({
        command: 'claude',
        args: ['mcp', 'add', 'slopweaver', '--', 'npx', '-y', '@slopweaver/mcp-local'],
        timeoutMs: 10_000,
      });
      // File should NOT have been created — `claude mcp add` is responsible
      // for writing to ~/.claude.json on its own.
      await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
    });

    it('falls back to direct JSON write when `claude` is missing (ENOENT)', async () => {
      const configPath = join(home, '.claude.json');
      const exec = fakeExec({
        kind: 'spawn-error',
        cause: Object.assign(new Error('not found'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
      });

      const result = await registerClient({
        kind: 'claude-code',
        configPath,
        exec,
      });

      expect(result.isOk()).toBe(true);
      const written = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(written).toEqual({
        mcpServers: {
          slopweaver: { command: 'npx', args: ['-y', '@slopweaver/mcp-local'] },
        },
      });
    });

    it('returns INIT_CLAUDE_MCP_ADD_FAILED when `claude mcp add` exits non-zero (does NOT overwrite ~/.claude.json)', async () => {
      const configPath = join(home, '.claude.json');
      // Pre-seed an existing config with other keys so we can prove it
      // isn't clobbered.
      await writeFile(
        configPath,
        JSON.stringify({ keepMe: true, mcpServers: { other: { command: 'node' } } }, null, 2),
        'utf-8',
      );
      const exec = fakeExec({
        kind: 'non-zero',
        exitCode: 2,
        stdout: '',
        stderr: 'auth required\n',
      });

      const result = await registerClient({
        kind: 'claude-code',
        configPath,
        exec,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('INIT_CLAUDE_MCP_ADD_FAILED');
        expect(result.error.message).toContain('exited 2');
        expect(result.error.message).toContain('auth required');
      }
      // Original config must be untouched — slopweaver MUST NOT have appeared.
      const stillThere = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(stillThere).toEqual({ keepMe: true, mcpServers: { other: { command: 'node' } } });
    });

    it('returns INIT_CLAUDE_MCP_ADD_FAILED on a timeout-killed exit (no fallback write)', async () => {
      // execFile's timeout fires SIGTERM and propagates as a non-numeric
      // `code`. DEFAULT_EXEC normalises that to `kind: 'non-zero', exitCode: 1`,
      // and the caller must treat it as a real failure rather than fallback.
      const configPath = join(home, '.claude.json');
      const exec = fakeExec({
        kind: 'non-zero',
        exitCode: 1,
        stdout: '',
        stderr: 'killed by SIGTERM',
      });

      const result = await registerClient({
        kind: 'claude-code',
        configPath,
        exec,
      });

      expect(result.isErr()).toBe(true);
      // File should not have been created.
      await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
    });
  });

  describe('cursor', () => {
    it('creates parent dirs and writes a fresh config when nothing exists yet', async () => {
      const configPath = join(home, '.cursor', 'mcp.json');

      const result = await registerClient({
        kind: 'cursor',
        configPath,
      });

      expect(result.isOk()).toBe(true);
      const written = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(written).toEqual({
        mcpServers: {
          slopweaver: { command: 'npx', args: ['-y', '@slopweaver/mcp-local'] },
        },
      });
    });
  });

  describe('cline', () => {
    it('preserves existing mcpServers entries while adding slopweaver', async () => {
      const configPath = join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              other: { command: 'node', args: ['./other.js'] },
            },
            unrelatedKey: 'keep me',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await registerClient({
        kind: 'cline',
        configPath,
      });

      expect(result.isOk()).toBe(true);
      const written = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(written).toEqual({
        unrelatedKey: 'keep me',
        mcpServers: {
          other: { command: 'node', args: ['./other.js'] },
          slopweaver: { command: 'npx', args: ['-y', '@slopweaver/mcp-local'] },
        },
      });
    });

    it('returns INIT_MCP_CONFIG_MALFORMED when existing file is not valid JSON', async () => {
      const configPath = join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, 'this is not json', 'utf-8');

      const result = await registerClient({
        kind: 'cline',
        configPath,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('INIT_MCP_CONFIG_MALFORMED');
      }
      // Original file must be untouched.
      expect(await readFile(configPath, 'utf-8')).toBe('this is not json');
    });
  });
});
