/**
 * `prepare_send` — read a draft file, parse the YAML frontmatter,
 * resolve the `target:` to a typed platform target, return the body
 * + structured MCP routing data + an instruction block for the model
 * to actually invoke the right MCP send tool.
 *
 * SlopWeaver's MCP server can't call other MCP servers across the SDK
 * boundary — that's the client's job (Claude Code in practice). So we
 * prepare the payload + tell the model which `mcp__*__*` tool to call
 * with which arguments, and the model executes.
 *
 * Two-step confirmation flow. The first call (without `confirmed`)
 * returns `requires_confirmation: true`, a `confirmation_token`, the
 * routing metadata (`server`, `tool_name`), and the body — but **not**
 * `tool_args`. The model surfaces the 5-second undo gate to the user.
 * Only after the user OKs does the model call `prepare_send` again
 * with `confirmed: true` + the same token; that response includes
 * `tool_args` (the executable payload). "Never auto-send without
 * confirmation" is therefore enforced by the contract, not just prose.
 *
 * The `confirmation_token` is deterministic per (draft_path,
 * frontmatter_hash) so a re-call from the same draft state yields the
 * same token. Editing the draft between calls changes the hash, which
 * changes the token, which invalidates any pending confirmation.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrepareSendArgs, PrepareSendResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';
import { hashFrontmatter, parseFrontmatter } from './parse-frontmatter.ts';
import { parseTarget, type ParsedTarget } from './parse-target.ts';

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
      'Read a draft file, parse its YAML frontmatter, validate the `target:` field, and return the parsed target + body + structured MCP routing (`server`, `tool_name`) + an instruction block. Two-step confirmation: the first call returns `requires_confirmation: true` and a `confirmation_token` but omits the executable `tool_args`; the second call (`confirmed: true` + same token) returns `tool_args` for the model to execute. Includes the 5-second undo gate in the instructions on the first pass.',
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
      const parsed = parseFrontmatter({ input: content });
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
      const target = parseTarget({ target: targetRaw });
      if (target === null) {
        return err(
          McpErrors.unexpected(
            'prepare_send',
            undefined,
            `target "${targetRaw}" does not match any supported shape (slack:<channel>[/thread:<ts>], github:<owner>/<repo>/(pull|pulls|issue|issues)/<n>, gmail:<thread_id>, linear:<issue_id>)`,
          ),
        );
      }
      const body = parsed.body.trim();
      if (body.length === 0) {
        return err(McpErrors.unexpected('prepare_send', undefined, `draft at ${input.draft_path} has an empty body`));
      }
      const draftId = parsed.frontmatter['draft_id'];
      const frontmatterHash = hashFrontmatter({ frontmatter: parsed.frontmatter });
      const confirmationToken = deriveConfirmationToken({
        draftPath: input.draft_path,
        frontmatterHash,
      });

      const isConfirmed = input.confirmed === true;
      if (isConfirmed && input.confirmation_token !== confirmationToken) {
        return err(
          McpErrors.unexpected(
            'prepare_send',
            undefined,
            `confirmation_token mismatch — re-call prepare_send without \`confirmed\` to fetch a fresh token (the draft frontmatter may have changed since the first call)`,
          ),
        );
      }

      const routing = buildRouting({ target, body });
      return ok({
        ...(draftId != null && draftId.length > 0 && { draft_id: draftId }),
        target,
        body,
        server: routing.server,
        tool_name: routing.tool_name,
        ...(isConfirmed && { tool_args: routing.tool_args }),
        requires_confirmation: !isConfirmed,
        confirmation_token: confirmationToken,
        frontmatter_hash: frontmatterHash,
        instructions: buildInstructions({
          target,
          draftPath: input.draft_path,
          routing,
          isConfirmed,
          confirmationToken,
          frontmatterHash,
          draftId: draftId != null && draftId.length > 0 ? draftId : null,
        }),
        generated_at: new Date(now()).toISOString(),
      });
    },
  });
}

/**
 * `tool_args` must serialise cleanly through the MCP wire (JSON) and
 * round-trip through the `PrepareSendResult` Zod schema, which expects
 * `Record<string, JsonValue>`. Mirror the JsonValue shape locally so
 * the buildRouting helper's return type lines up with the contract
 * without importing the type from `@slopweaver/contracts` (it's not in
 * the public exports). The shape (mutable Array, mutable object) is
 * intentionally the same as the contracts' internal `JsonValue` so
 * structural assignment works under TS's strict structural compat
 * check.
 */
type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type ToolArgs = Record<string, JsonValue>;

type Routing = {
  readonly server: string;
  readonly tool_name: string;
  readonly tool_args: ToolArgs;
};

/**
 * Map a parsed target to the downstream MCP server + tool + args. GitHub
 * stays on the MCP routing path (no `gh api` fallback) — `mcp__github__add_issue_comment`
 * handles both issue and PR comments (PR comments use the issues
 * endpoint upstream).
 */
function buildRouting({ target, body }: { target: ParsedTarget; body: string }): Routing {
  if (target.platform === 'slack') {
    const args: ToolArgs = { channel_id: target.channel, text: body };
    if (target.thread_ts != null) args['thread_ts'] = target.thread_ts;
    return { server: 'slack', tool_name: 'slack_send_message', tool_args: args };
  }
  if (target.platform === 'github') {
    return {
      server: 'github',
      tool_name: 'add_issue_comment',
      tool_args: {
        owner: target.owner,
        repo: target.repo,
        issue_number: target.number,
        body,
      },
    };
  }
  if (target.platform === 'gmail') {
    return {
      server: 'gmail',
      tool_name: 'send_message',
      tool_args: { thread_id: target.thread_id, body },
    };
  }
  return {
    server: 'linear',
    tool_name: 'create_comment',
    tool_args: { issueId: target.issue_id, body },
  };
}

/**
 * Deterministic per-draft-state token. Tying the token to the
 * frontmatter hash (not just a random nonce) means: editing the draft
 * between the first and second call changes the hash → changes the
 * token → the second call fails the equality check. That's the
 * "drift detection" half of the confirmation gate.
 */
function deriveConfirmationToken({
  draftPath,
  frontmatterHash,
}: {
  draftPath: string;
  frontmatterHash: string;
}): string {
  return createHash('sha256').update(`${draftPath}\n${frontmatterHash}`, 'utf-8').digest('hex').slice(0, 24);
}

function buildInstructions(args: {
  target: ParsedTarget;
  draftPath: string;
  routing: Routing;
  isConfirmed: boolean;
  confirmationToken: string;
  frontmatterHash: string;
  draftId: string | null;
}): string {
  if (!args.isConfirmed) {
    return `# Confirm the send\n\nA draft is ready at \`${args.draftPath}\`. Routing:\n\n- server: \`${args.routing.server}\`\n- tool: \`${args.routing.tool_name}\`\n- target: ${describeTarget(args.target)}\n\nSurface this one-liner to the user:\n\n> Sending to ${describeTarget(args.target)} in 5 seconds. Reply with \`undo\` to cancel.\n\nWait for either an \`undo\` (in which case call \`record_send_outcome\` with status \`cancelled\` and stop) or 5 seconds of silence.\n\nThen re-call \`prepare_send\` with \`confirmed: true\` and \`confirmation_token: "${args.confirmationToken}"\` to receive the executable \`tool_args\`. Do not invoke any send tool without that second response — the contract intentionally omits \`tool_args\` on the unconfirmed pass.\n`;
  }
  const draftIdLine = args.draftId != null ? `, draft_id: "${args.draftId}"` : '';
  return `# Execute the send\n\nInvoke \`mcp__${args.routing.server}__${args.routing.tool_name}\` with the \`tool_args\` from this response. After it returns:\n\n- On success: \`record_send_outcome({ draft_path: "${args.draftPath}"${draftIdLine}, frontmatter_hash: "${args.frontmatterHash}", status: "sent", sent_url: <permalink-from-send-response> })\`\n- On failure: \`record_send_outcome({ draft_path: "${args.draftPath}"${draftIdLine}, frontmatter_hash: "${args.frontmatterHash}", status: "failed", error: <message> })\`\n`;
}

function describeTarget(target: ParsedTarget): string {
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
