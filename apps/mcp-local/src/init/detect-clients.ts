/**
 * Detect which MCP clients are installed on this machine and whether each
 * one already lists `slopweaver` under its `mcpServers` (or equivalent) key.
 *
 * The wizard uses this to decide which clients to offer to register against.
 * "Detected" means we found the config file on disk; "hasSlopweaver" means
 * the file parses as JSON and contains an `mcpServers.slopweaver` entry.
 *
 * v1 scope per issue #39: Claude Code (`~/.claude.json`), Cursor
 * (`~/.cursor/mcp.json`), and Cline
 * (`~/.cline/data/settings/cline_mcp_settings.json`). Codex CLI uses TOML
 * and is documented in README but out of scope here — file a follow-up if
 * needed.
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
  configPath: string;
  exists: boolean;
  hasSlopweaver: boolean;
};

export type DetectClientsArgs = {
  home: string;
  fs?: {
    access: (path: string) => Promise<void>;
    readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  };
};

const REAL_FS = {
  access: (path: string) => access(path),
  readFile: (path: string, encoding: BufferEncoding) => readFile(path, encoding),
};

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

const ALL_KINDS: ReadonlyArray<McpClientKind> = ['claude-code', 'cursor', 'cline'];

export async function detectClients({
  home,
  fs = REAL_FS,
}: DetectClientsArgs): Promise<DetectedClient[]> {
  const results: DetectedClient[] = [];

  for (const kind of ALL_KINDS) {
    const configPath = configPathFor({ kind, home });
    const exists = await fileExists({ path: configPath, fs });

    if (!exists) {
      results.push({ kind, configPath, exists: false, hasSlopweaver: false });
      continue;
    }

    const hasSlopweaver = await readHasSlopweaver({ path: configPath, fs });
    results.push({ kind, configPath, exists: true, hasSlopweaver });
  }

  return results;
}

async function fileExists({
  path,
  fs,
}: {
  path: string;
  fs: NonNullable<DetectClientsArgs['fs']>;
}): Promise<boolean> {
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
