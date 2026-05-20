/**
 * `read_console_file` MCP tool. Read a file under the configured console
 * directory. Missing files return `exists: false` rather than failing —
 * `/session-start` uses this on first run to detect which sections need
 * bootstrapping.
 */

import { ReadConsoleFileArgs, ReadConsoleFileResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { safeReadConsoleFile } from '../../work-console/files.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateReadConsoleFileToolArgs = {
  config?: WorkConsoleConfig;
};

export function createReadConsoleFileTool(args: CreateReadConsoleFileToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();

  return defineTool({
    name: 'read_console_file',
    description:
      'Reads a file under the AI work-console directory (relative path, jailed to the console dir). Missing file returns exists=false; not an error.',
    inputSchema: ReadConsoleFileArgs,
    outputSchema: ReadConsoleFileResult,
    handler: async ({ input }) => {
      const result = await safeReadConsoleFile(config, input.path);
      if (result.isErr()) {
        return err(McpErrors.unexpected('read_console_file', undefined, result.error.message));
      }
      const r = result.value;
      return ok({
        path: r.absolutePath,
        exists: r.exists,
        content: r.content,
        bytes: r.bytes,
      });
    },
  });
}
