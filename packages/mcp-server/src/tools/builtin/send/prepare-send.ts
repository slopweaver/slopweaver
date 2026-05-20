/**
 * `prepare_send` — read a draft file, parse the YAML frontmatter,
 * resolve the `target:` to a typed platform target, return the body
 * + an instruction block for the model to actually invoke the right
 * MCP send tool.
 *
 * SlopWeaver's MCP server can't call other MCP servers across the SDK
 * boundary — that's the client's job (Claude Code in practice). So we
 * prepare the payload + tell the model which `mcp__*__*` tool to call
 * with which arguments, and the model executes.
 *
 * Includes a 5-second "undo gate" instruction in the body so the model
 * pauses before invoking the actual send tool — gives the user a
 * chance to type `undo` and abort.
 */

import { readFile } from 'node:fs/promises';
import { PrepareSendArgs, PrepareSendResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';
import { parseFrontmatter } from './parse-frontmatter.ts';
import { parseTarget } from './parse-target.ts';

export type CreatePrepareSendToolArgs = {
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Override the fs reader (tests). */
  readFileImpl?: (path: string) => Promise<string>;
};

export function createPrepareSendTool(args: CreatePrepareSendToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const readImpl = args.readFileImpl ?? ((p) => readFile(p, 'utf-8'));

  return defineTool({
    name: 'prepare_send',
    description:
      'Read a draft file, parse its YAML frontmatter, validate the `target:` field, and return the parsed target + body + an instruction block telling the model exactly which platform MCP tool to invoke with which arguments. Does NOT send — the model runs the next tool. Includes the 5-second undo gate as part of the instructions.',
    inputSchema: PrepareSendArgs,
    outputSchema: PrepareSendResult,
    handler: async ({ input }) => {
      let content: string;
      try {
        content = await readImpl(input.draft_path);
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'prepare_send',
            undefined,
            `failed to read draft at ${input.draft_path}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      const parsed = parseFrontmatter(content);
      if (parsed === null) {
        return err(
          McpErrors.unexpected(
            'prepare_send',
            undefined,
            `draft at ${input.draft_path} has no parseable YAML frontmatter; required keys: target, draft_id`,
          ),
        );
      }
      const targetRaw = parsed.frontmatter['target'];
      if (targetRaw == null || targetRaw.length === 0) {
        return err(
          McpErrors.unexpected(
            'prepare_send',
            undefined,
            `draft at ${input.draft_path} is missing the required \`target:\` frontmatter field`,
          ),
        );
      }
      const target = parseTarget(targetRaw);
      if (target === null) {
        return err(
          McpErrors.unexpected(
            'prepare_send',
            undefined,
            `target "${targetRaw}" does not match any supported shape (slack:<channel>[/thread:<ts>], github:<owner>/<repo>/(pull|issue)/<n>, gmail:<thread_id>, linear:<issue_id>)`,
          ),
        );
      }
      const body = parsed.body.trim();
      if (body.length === 0) {
        return err(McpErrors.unexpected('prepare_send', undefined, `draft at ${input.draft_path} has an empty body`));
      }
      const draftId = parsed.frontmatter['draft_id'];
      return ok({
        ...(draftId != null && draftId.length > 0 && { draft_id: draftId }),
        target,
        body,
        instructions: buildInstructions({ target, body, draftPath: input.draft_path }),
        generated_at: new Date(now()).toISOString(),
      });
    },
  });
}

function buildInstructions(args: {
  target: ReturnType<typeof parseTarget> & object;
  body: string;
  draftPath: string;
}): string {
  const lead = `# Send the draft\n\nA draft is ready at \`${args.draftPath}\`. Before invoking the send tool, surface this one-liner to the user:\n\n> Sending to ${describeTarget(args.target)} in 5 seconds. Reply with \`undo\` to cancel.\n\nWait for either an \`undo\` (in which case call \`record_send_outcome\` with status \`cancelled\` and stop) or 5 seconds of silence.\n\n`;
  const exec = renderExec(args.target);
  const post = `\nAfter the send tool returns, call \`record_send_outcome({ draft_path: "${args.draftPath}", status: "sent", sent_url: <permalink-from-send-response> })\`. If the send tool errors, call it with status \`failed\` and the error message.\n`;
  return `${lead}${exec}${post}`;
}

function describeTarget(target: ReturnType<typeof parseTarget> & object): string {
  if (target.platform === 'slack') {
    return target.thread_ts != null
      ? `Slack thread ${target.thread_ts} in channel ${target.channel}`
      : `Slack channel ${target.channel}`;
  }
  if (target.platform === 'github') {
    return `GitHub ${target.kind} #${target.number} in ${target.owner}/${target.repo}`;
  }
  if (target.platform === 'gmail') {
    return `Gmail thread ${target.thread_id}`;
  }
  return `Linear issue ${target.issue_id}`;
}

function renderExec(target: ReturnType<typeof parseTarget> & object): string {
  if (target.platform === 'slack') {
    const threadLine = target.thread_ts != null ? `, thread_ts: "${target.thread_ts}"` : '';
    return `\`\`\`\nslack_send_message({ channel_id: "${target.channel}"${threadLine}, text: <body> })\n\`\`\`\n`;
  }
  if (target.platform === 'github') {
    return `\`\`\`\ngh api -X POST /repos/${target.owner}/${target.repo}/issues/${target.number}/comments -F body=<body>\n\`\`\`\n(Or use the equivalent github MCP tool if one is connected.)\n`;
  }
  if (target.platform === 'gmail') {
    return `\`\`\`\nmcp__gmail__send_message({ thread_id: "${target.thread_id}", body: <body> })\n\`\`\`\n(Send via reply to existing thread.)\n`;
  }
  return `\`\`\`\nmcp__linear__create_comment({ issueId: "${target.issue_id}", body: <body> })\n\`\`\`\n`;
}
