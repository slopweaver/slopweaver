/**
 * CLI adapter for the `slack-send-image` subcommand. Resolves config
 * from env + flags, hands off to the pure `sendSlackImage` helper, and
 * prints a one-line outcome.
 *
 * The xoxc token is read from `--xoxc` or the `SLACK_XOXC` env var only.
 * No keychain fetch, no browser cookie extraction. The skill that wraps
 * this command is responsible for getting the token to the user; the
 * binary just consumes it.
 */

import { sendSlackImage } from './upload.ts';
import type { SlackImageError } from './errors.ts';
import type { SendImageResult, SlackImageUploadConfig } from './types.ts';

export type SlackSendImageFlags = {
  readonly channel: string;
  readonly text: string;
  readonly image: string;
  readonly thread?: string;
  readonly xoxc?: string;
  readonly workspaceUrl?: string;
  readonly slackRoute?: string;
};

export type SlackSendImageIo = {
  readonly stdout: { write: (s: string) => void };
  readonly stderr: { write: (s: string) => void };
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * Resolve the runtime config or report which env/flag the caller missed.
 * Pure (no I/O); reads from `flags` and `env` only.
 */
export function resolveConfig({
  flags,
  env,
}: {
  flags: SlackSendImageFlags;
  env: Readonly<Record<string, string | undefined>>;
}): { ok: true; config: SlackImageUploadConfig } | { ok: false; error: string } {
  const token = flags.xoxc ?? env['SLACK_XOXC'];
  if (token === undefined || token.length === 0) {
    return {
      ok: false,
      error: 'no xoxc token. Pass --xoxc or set SLACK_XOXC. Extract from a logged-in Slack browser tab.',
    };
  }
  const apiBaseUrl = flags.workspaceUrl ?? env['SLOPWEAVER_SLACK_WORKSPACE_URL'];
  if (apiBaseUrl === undefined || apiBaseUrl.length === 0) {
    return {
      ok: false,
      error:
        'no workspace URL. Pass --workspace-url https://<workspace>.slack.com or set SLOPWEAVER_SLACK_WORKSPACE_URL.',
    };
  }
  const slackRoute = flags.slackRoute ?? env['SLOPWEAVER_SLACK_ROUTE'];
  return {
    ok: true,
    config: {
      apiBaseUrl,
      token,
      ...(slackRoute !== undefined && slackRoute.length > 0 ? { slackRoute } : {}),
    },
  };
}

function formatErrorLine({ error }: { error: SlackImageError }): string {
  if (error.code === 'SLACK_IMAGE_SHARE_FAILED' && error.slackError !== undefined) {
    return `slack-send-image: ${error.code} (slack: ${error.slackError})`;
  }
  if (error.code === 'SLACK_IMAGE_UPLOAD_URL_FAILED' && error.slackError !== undefined) {
    return `slack-send-image: ${error.code} (slack: ${error.slackError})`;
  }
  if (error.code === 'SLACK_IMAGE_COMPLETE_FAILED' && error.slackError !== undefined) {
    return `slack-send-image: ${error.code} (slack: ${error.slackError})`;
  }
  return `slack-send-image: ${error.code} ${error.message}`;
}

function formatSuccessLine({
  result,
  channel,
  threadTs,
}: {
  result: SendImageResult;
  channel: string;
  threadTs?: string;
}): string {
  const where = threadTs === undefined ? channel : `${channel}/${threadTs}`;
  return `slack-send-image: ok file=${result.fileId} ts=${result.fileMsgTs} where=${where}`;
}

/**
 * Run the subcommand against the provided IO. Returns the exit code the
 * caller should pass to `process.exit`.
 */
export async function runSlackSendImage({
  flags,
  io,
}: {
  flags: SlackSendImageFlags;
  io: SlackSendImageIo;
}): Promise<number> {
  const resolved = resolveConfig({ flags, env: io.env });
  if (!resolved.ok) {
    io.stderr.write(`slack-send-image: ${resolved.error}\n`);
    return 2;
  }
  const result = await sendSlackImage({
    config: resolved.config,
    channelId: flags.channel,
    text: flags.text,
    imagePath: flags.image,
    ...(flags.thread !== undefined ? { threadTs: flags.thread } : {}),
  });
  if (result.isErr()) {
    io.stderr.write(`${formatErrorLine({ error: result.error })}\n`);
    return 1;
  }
  io.stdout.write(
    `${formatSuccessLine({
      result: result.value,
      channel: flags.channel,
      ...(flags.thread !== undefined ? { threadTs: flags.thread } : {}),
    })}\n`,
  );
  return 0;
}
