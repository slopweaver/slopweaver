/**
 * `register_handoff` MCP tool. Writes a self-contained handoff prompt
 * to `.claude/personal/handoffs/<anchor-slug>.md` for the user to paste
 * into a separate Claude Code chat (CMUX-style parallel chats). Called
 * by the `/lock-in` walker when the user picks `handoff`.
 *
 * The anchor is slugified: lowercased, non-`[a-z0-9-]` chars replaced
 * with `-`, runs of `-` collapsed, leading/trailing `-` stripped. So
 * `PLT-583` → `plt-583`, `#10407` → `10407`, `PR #10407 deploy review`
 * → `pr-10407-deploy-review`.
 */

import { RegisterHandoffArgs, RegisterHandoffResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { safeReadConsoleFile, safeWriteConsoleFile } from '../../work-console/files.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateRegisterHandoffToolArgs = {
  config?: WorkConsoleConfig;
};

export function slugifyAnchor(anchor: string): string {
  return anchor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createRegisterHandoffTool(args: CreateRegisterHandoffToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();

  return defineTool({
    name: 'register_handoff',
    description:
      'Writes a handoff prompt to .claude/personal/handoffs/<slug>.md. Anchor is slugified for the filename. Refuses to overwrite an existing handoff unless overwrite=true.',
    inputSchema: RegisterHandoffArgs,
    outputSchema: RegisterHandoffResult,
    handler: async ({ input }) => {
      const slug = slugifyAnchor(input.anchor);
      if (slug.length === 0) {
        return err(
          McpErrors.unexpected(
            'register_handoff',
            undefined,
            `anchor "${input.anchor}" slugifies to an empty string; choose something containing at least one alphanumeric character`,
          ),
        );
      }
      const relPath = `handoffs/${slug}.md`;
      const overwrite = input.overwrite === true;

      if (!overwrite) {
        const existing = await safeReadConsoleFile(config, relPath);
        if (existing.isErr()) {
          return err(McpErrors.unexpected('register_handoff', undefined, existing.error.message));
        }
        if (existing.value.exists) {
          return err(
            McpErrors.unexpected(
              'register_handoff',
              undefined,
              `handoff already exists at ${existing.value.absolutePath}; pass overwrite=true to replace`,
            ),
          );
        }
      }

      const content = renderHandoffMarkdown(input.title, input.body);
      const write = await safeWriteConsoleFile(config, relPath, content);
      if (write.isErr()) {
        return err(McpErrors.unexpected('register_handoff', undefined, write.error.message));
      }
      return ok({
        path: write.value.absolutePath,
        bytes_written: write.value.bytesWritten,
        created: write.value.created,
      });
    },
  });
}

function renderHandoffMarkdown(title: string, body: string): string {
  const normalisedBody = body.endsWith('\n') ? body : `${body}\n`;
  return `# Handoff: ${title}\n\n${normalisedBody}`;
}
