/**
 * Detect which MCP clients are installed on this machine and whether each
 * one already lists `slopweaver` under its `mcpServers` (or equivalent) key.
 *
 * The wizard uses this to decide which clients to offer to register against.
 * "Detected" means we found the config file on disk; "hasSlopweaver" means
 * the file parses as JSON and contains an `mcpServers.slopweaver` entry.
 *
 * v1 scope per issue #39: Claude Code (`~/.claude.json`), Cursor
 * (`~/.cursor/mcp.json` and project-local `<cwd>/.cursor/mcp.json` when it
 * exists), and Cline (`$CLINE_DIR/data/settings/cline_mcp_settings.json` if
 * the env var is set, else `~/.cline/data/settings/cline_mcp_settings.json`).
 * Codex CLI uses TOML and is documented in README but out of scope here —
 * file a follow-up if needed.
 *
 * Cursor's project-local entry is emitted only when the file already exists.
 * We don't speculatively write to `<cwd>/.cursor/mcp.json` because the wizard
 * typically runs from `npx` in whatever directory the user is in (often not
 * a "Cursor project"), so creating the file there would litter random
 * directories.
 *
 * Malformed-JSON case: we deliberately report `hasSlopweaver: false`
 * (not an error) so the wizard surfaces the situation as "register"
 * candidate. The register step then refuses to overwrite a malformed
 * file, returning `INIT_MCP_CONFIG_MALFORMED` instead of clobbering the
 * user's broken config. That keeps the two concerns separate: detect
 * answers "does it look registered?", register answers "what happens if
 * I try to write?".
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type McpClientKind = 'claude-code' | 'cursor' | 'cline';

export type DetectedClient = {
  kind: McpClientKind;
  /** Free-form label distinguishing same-kind entries, e.g. "home" vs "project". */
  variant: 'home' | 'project' | 'env-override';
  configPath: string;
  exists: boolean;
  hasSlopweaver: boolean;
};

export type DetectClientsArgs = {
  home: string;
  /** Current working directory — used to probe project-local `.cursor/mcp.json`. */
  cwd: string;
  /** Value of `$CLINE_DIR` env var, or `undefined` to fall back to `~/.cline`. */
  clineDir: string | undefined;
  fs?: {
    access: (path: string) => Promise<void>;
    readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  };
};

const REAL_FS = {
  access: (path: string) => access(path),
  readFile: (path: string, encoding: BufferEncoding) => readFile(path, encoding),
};

/**
 * Resolve the canonical home-dir config path for `kind`. Used both by
 * detect (to probe) and by the wizard (to decide where to write when no
 * existing path is found).
 */
export function configPathFor({ kind, home }: { kind: McpClientKind; home: string }): string {
  switch (kind) {
    case 'claude-code':
      return join(home, '.claude.json');
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'cline':
      return join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  }
}

/**
 * Resolve the actual on-disk Cline config path, honouring `$CLINE_DIR` when set.
 */
export function clineConfigPath({ home, clineDir }: { home: string; clineDir: string | undefined }): string {
  const base = clineDir ?? join(home, '.cline');
  return join(base, 'data', 'settings', 'cline_mcp_settings.json');
}

export async function detectClients({
  home,
  cwd,
  clineDir,
  fs = REAL_FS,
}: DetectClientsArgs): Promise<DetectedClient[]> {
  const candidates: ReadonlyArray<Omit<DetectedClient, 'exists' | 'hasSlopweaver'>> = [
    {
      kind: 'claude-code',
      variant: 'home',
      configPath: configPathFor({ kind: 'claude-code', home }),
    },
    {
      kind: 'cursor',
      variant: 'home',
      configPath: configPathFor({ kind: 'cursor', home }),
    },
    // Project-local Cursor: only included when the file exists. The issue
    // text explicitly lists `.cursor/mcp.json` (no tilde) so we have to
    // detect it; we just don't write to it speculatively.
    {
      kind: 'cursor',
      variant: 'project',
      configPath: join(cwd, '.cursor', 'mcp.json'),
    },
    {
      kind: 'cline',
      variant: clineDir === undefined ? 'home' : 'env-override',
      configPath: clineConfigPath({ home, clineDir }),
    },
  ];

  const results: DetectedClient[] = [];

  for (const candidate of candidates) {
    const exists = await fileExists({ path: candidate.configPath, fs });

    // Suppress the project-local Cursor entry when it doesn't exist —
    // otherwise we'd offer the user "register slopweaver in /some/random/dir/.cursor/mcp.json?"
    // which is almost never what they want.
    if (candidate.kind === 'cursor' && candidate.variant === 'project' && !exists) {
      continue;
    }

    if (!exists) {
      results.push({ ...candidate, exists: false, hasSlopweaver: false });
      continue;
    }

    const hasSlopweaver = await readHasSlopweaver({ path: candidate.configPath, fs });
    results.push({ ...candidate, exists: true, hasSlopweaver });
  }

  return results;
}

async function fileExists({ path, fs }: { path: string; fs: NonNullable<DetectClientsArgs['fs']> }): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readHasSlopweaver({
  path,
  fs,
}: {
  path: string;
  fs: NonNullable<DetectClientsArgs['fs']>;
}): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    // File disappeared between access() and readFile(), or is unreadable.
    // Treat as "not registered" so the wizard offers to write a fresh one;
    // the register step has its own malformed-file guard.
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) return false;
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null) return false;
  return 'slopweaver' in mcpServers;
}
