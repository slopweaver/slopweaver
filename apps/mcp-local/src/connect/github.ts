/**
 * `slopweaver connect github` — prompt for a fine-grained PAT, validate it
 * against GitHub, and persist into `integration_tokens`.
 *
 * Validation hits `users.getAuthenticated` — the cheapest call that confirms
 * the token is valid AND surfaces the login we want to display back to the
 * user. We deliberately do NOT call `fetchIdentity` here: that helper writes
 * to `identity_graph` as a side effect, which is the right thing for the
 * polling layer but wrong for `connect`, which should be re-runnable without
 * leaving graph-state debris on a typo.
 *
 * All collaborators are dependency-injected so unit tests can substitute fake
 * prompt + fake validate without `vi.mock`.
 */

import { type SlopweaverDatabase, saveIntegrationToken } from '@slopweaver/db';

const INTEGRATION = 'github';

export type RunConnectGithubDeps = {
  db: SlopweaverDatabase;
  promptForToken: (opts: { message: string }) => Promise<string>;
  validateToken: (token: string) => Promise<{ login: string }>;
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
  now?: () => number;
};

/**
 * Runs the connect-github flow. Returns the desired process exit code so the
 * CLI wrapper can call `exit(code)` once.
 */
export async function runConnectGithub({
  db,
  promptForToken,
  validateToken,
  stdout,
  stderr,
  now,
}: RunConnectGithubDeps): Promise<number> {
  const token = await promptForToken({
    message: 'GitHub fine-grained PAT (input hidden):',
  });

  let login: string;
  try {
    ({ login } = await validateToken(token));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`slopweaver: GitHub token rejected: ${message}\n`);
    return 1;
  }

  saveIntegrationToken({
    db,
    integration: INTEGRATION,
    token,
    accountLabel: login,
    ...(now ? { now } : {}),
  });

  stdout.write(`Connected to GitHub as ${login}.\n`);
  return 0;
}
