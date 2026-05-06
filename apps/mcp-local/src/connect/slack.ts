/**
 * `slopweaver connect slack` — prompt for a Slack bot/user token (xoxb-/xoxp-),
 * validate it via `auth.test`, and persist into `integration_tokens`.
 *
 * `auth.test` is the canonical "is this token valid + which workspace" call.
 * It works for both bot and user tokens, mirroring what `fetchIdentity` does
 * internally but without writing to `identity_graph` (see the github sibling
 * for the same rationale).
 *
 * Collaborators are dependency-injected for the same testability reason as
 * github.ts.
 */

import { type SlopweaverDatabase, saveIntegrationToken } from '@slopweaver/db';

const INTEGRATION = 'slack';

export type RunConnectSlackDeps = {
  db: SlopweaverDatabase;
  promptForToken: (opts: { message: string }) => Promise<string>;
  validateToken: (token: string) => Promise<{ team: string | null }>;
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
    message: 'Slack token (xoxb- or xoxp-, input hidden):',
  });

  let team: string | null;
  try {
    ({ team } = await validateToken(token));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`slopweaver: Slack token rejected: ${message}\n`);
    return 1;
  }

  saveIntegrationToken({
    db,
    integration: INTEGRATION,
    token,
    accountLabel: team,
    ...(now ? { now } : {}),
  });

  if (team) {
    stdout.write(`Connected to Slack workspace "${team}".\n`);
  } else {
    stdout.write('Connected to Slack.\n');
  }
  return 0;
}
