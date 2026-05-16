/**
 * `slopweaver connect slack` — prompt for a Slack user token (xoxp-), validate
 * it via `auth.test`, and persist into `integration_tokens`.
 *
 * Why user-token-only: Slack `search.messages` (the call the mentions poller
 * relies on) rejects bot tokens with `not_allowed_token_type`, so accepting
 * an `xoxb-` here would silently set the user up for a polling failure later.
 * We reject the bot-token prefix at connect time with a clear message rather
 * than letting them discover this via Wave-3 logs.
 *
 * `auth.test` is the canonical "is this token valid + which workspace" call.
 *
 * Collaborators are dependency-injected for the same testability reason as
 * github.ts.
 */

import { type SlopweaverDatabase, saveIntegrationToken } from '@slopweaver/db';
import type { BaseError, ResultAsync } from '@slopweaver/errors';

const INTEGRATION = 'slack';
const USER_TOKEN_PREFIX = 'xoxp-';

export type RunConnectSlackDeps = {
  db: SlopweaverDatabase;
  promptForToken: (opts: { message: string }) => Promise<string>;
  validateToken: (args: { token: string }) => ResultAsync<{ team: string | null }, BaseError>;
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
  now?: () => number;
};

export async function runConnectSlack({
  db,
  promptForToken,
  validateToken,
  stdout,
  stderr,
  now,
}: RunConnectSlackDeps): Promise<number> {
  const token = await promptForToken({
    message: 'Slack user token (xoxp-, input hidden):',
  });

  if (!token.startsWith(USER_TOKEN_PREFIX)) {
    stderr.write(
      'slopweaver: Slack token rejected: a user token (xoxp-) is required. Bot tokens (xoxb-) cannot call search.messages, which the mentions poller depends on.\n',
    );
    return 1;
  }

  const validateResult = await validateToken({ token });
  if (validateResult.isErr()) {
    stderr.write(`slopweaver: Slack token rejected: ${validateResult.error.message}\n`);
    return 1;
  }
  const { team } = validateResult.value;

  const saveResult = await saveIntegrationToken({
    db,
    integration: INTEGRATION,
    token,
    accountLabel: team,
    ...(now ? { now } : {}),
  });
  if (saveResult.isErr()) {
    stderr.write(`slopweaver: failed to save Slack token: ${saveResult.error.message}\n`);
    return 1;
  }

  if (team) {
    stdout.write(`Connected to Slack workspace "${team}".\n`);
  } else {
    stdout.write('Connected to Slack.\n');
  }
  return 0;
}
