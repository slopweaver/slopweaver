/**
 * `list_console_files` MCP tool. Lists the immediate children of a
 * sub-directory under the console dir. Missing dir is `entries: []`, not
 * an error — `/session-start` uses this to inventory the console.
 */

import { ListConsoleFilesArgs, ListConsoleFilesResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { listConsoleDir } from '../../work-console/files.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateListConsoleFilesToolArgs = {
  config?: WorkConsoleConfig;
};

export function createListConsoleFilesTool(args: CreateListConsoleFilesToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();

  return defineTool({
    name: 'list_console_files',
    description:
      'Lists immediate children of a sub-directory under the AI work-console directory. Missing dir → empty list (not an error). Entries are sorted alphabetically.',
    inputSchema: ListConsoleFilesArgs,
    outputSchema: ListConsoleFilesResult,
    handler: async ({ input }) => {
      const subdir = input.subdir ?? '.';
      const result = await listConsoleDir(config, subdir);
      if (result.isErr()) {
        return err(McpErrors.unexpected('list_console_files', undefined, result.error.message));
      }
      return ok({
        subdir: result.value.subdir,
        entries: result.value.entries.map((entry) => ({
          path: entry.relPath,
          kind: entry.kind,
          bytes: entry.bytes,
          modified_at: entry.modifiedAtIso,
        })),
      });
    },
  });
}
