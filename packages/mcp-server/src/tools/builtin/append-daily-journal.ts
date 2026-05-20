/**
 * `append_daily_journal` MCP tool. Appends a heading + body to today's
 * daily journal file at `.claude/personal/daily/<YYYY-MM>/<DD>.md`.
 * Creates the file with a date frontmatter on first append of the day.
 *
 * The MCP prompts use this for in-session notes, GitHub-delta-style
 * append blocks, "/session-start ran at HH:MM" markers, etc. Cheap
 * write — atomic-replace via `safeWriteConsoleFile`.
 */

import { AppendDailyJournalArgs, AppendDailyJournalResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { safeReadConsoleFile, safeWriteConsoleFile } from '../../work-console/files.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateAppendDailyJournalToolArgs = {
  config?: WorkConsoleConfig;
  now?: () => Date;
};

export function createAppendDailyJournalTool(args: CreateAppendDailyJournalToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();
  const now = args.now ?? (() => new Date());

  return defineTool({
    name: 'append_daily_journal',
    description:
      "Appends a `## <heading>` block plus body to today's daily journal at .claude/personal/daily/YYYY-MM/DD.md. Creates the file on first append. Uses today's local date unless `date` is supplied.",
    inputSchema: AppendDailyJournalArgs,
    outputSchema: AppendDailyJournalResult,
    handler: async ({ input }) => {
      const targetDate = input.date ?? formatDate(now());
      const segments = targetDate.split('-');
      const yyyy = segments[0];
      const mm = segments[1];
      const dd = segments[2];
      if (yyyy == null || mm == null || dd == null) {
        return err(
          McpErrors.unexpected('append_daily_journal', undefined, `date "${targetDate}" doesn't look like YYYY-MM-DD`),
        );
      }
      const relPath = `daily/${yyyy}-${mm}/${dd}.md`;

      const read = await safeReadConsoleFile(config, relPath);
      if (read.isErr()) {
        return err(McpErrors.unexpected('append_daily_journal', undefined, read.error.message));
      }

      const stanza = `## ${input.heading}\n\n${input.body.endsWith('\n') ? input.body : `${input.body}\n`}`;
      const created = !read.value.exists;
      const existingContent = read.value.content ?? '';
      const nextContent = created
        ? `---\ndate: ${targetDate}\n---\n\n${stanza}`
        : existingContent.endsWith('\n')
          ? `${existingContent}\n${stanza}`
          : `${existingContent}\n\n${stanza}`;

      const write = await safeWriteConsoleFile(config, relPath, nextContent);
      if (write.isErr()) {
        return err(McpErrors.unexpected('append_daily_journal', undefined, write.error.message));
      }
      return ok({
        path: write.value.absolutePath,
        bytes_written: write.value.bytesWritten,
        created: write.value.created,
      });
    },
  });
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
