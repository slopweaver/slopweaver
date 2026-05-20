/**
 * `write_console_file` MCP tool. Atomically writes a file under the
 * console directory. Creates parent dirs as needed. Setting
 * `create_if_missing: false` refuses to scaffold new files — useful when
 * the prompt explicitly wants to update an existing artefact and not
 * create one by accident.
 */

import { WriteConsoleFileArgs, WriteConsoleFileResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { safeWriteConsoleFile } from '../../work-console/files.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateWriteConsoleFileToolArgs = {
  config?: WorkConsoleConfig;
};

export function createWriteConsoleFileTool(args: CreateWriteConsoleFileToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();

  return defineTool({
    name: 'write_console_file',
    description:
      'Atomically writes a file under the AI work-console directory. Creates parent dirs. Pass create_if_missing=false to refuse new files.',
    inputSchema: WriteConsoleFileArgs,
    outputSchema: WriteConsoleFileResult,
    handler: async ({ input }) => {
      const result = await safeWriteConsoleFile(config, input.path, input.content, {
        createIfMissing: input.create_if_missing !== false,
      });
      if (result.isErr()) {
        return err(McpErrors.unexpected('write_console_file', undefined, result.error.message));
      }
      const r = result.value;
      return ok({
        path: r.absolutePath,
        bytes_written: r.bytesWritten,
        created: r.created,
      });
    },
  });
}
