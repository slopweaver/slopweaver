/**
 * CLI adapter for `slopweaver slack-extract-xoxc`. Reads a JSON or
 * plain-text dump from stdin, runs the pure `findXoxcInDump` helper,
 * and prints either the bare token or an `export SLACK_XOXC=...` line
 * the caller can `eval`.
 *
 * No browser drive happens here. The companion skill drives Playwright
 * to produce the input stream; this subcommand is the pure consumer.
 */

import { findXoxcInDump, findXoxcInValues } from './find-token.ts';

export type SlackExtractFlags = {
  /** Output format: `token` (default, bare token) or `export` (`export SLACK_XOXC=...`). */
  readonly format: 'token' | 'export';
};

export type SlackExtractIo = {
  readonly stdout: { write: (s: string) => void };
  readonly stderr: { write: (s: string) => void };
  readonly readStdin: () => Promise<string>;
};

function findToken({ input }: { input: string }): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const fromJson = findXoxcInDump({ dump: parsed });
      if (fromJson !== null) return fromJson;
    } catch {
      // Fall through to the raw-text scan; the input may have been
      // truncated or not actually JSON.
    }
  }
  return findXoxcInValues({ values: [input] });
}

function formatOutput({ token, format }: { token: string; format: 'token' | 'export' }): string {
  return format === 'export' ? `export SLACK_XOXC=${token}\n` : `${token}\n`;
}

/**
 * Run the subcommand. Returns the exit code:
 *   0 — token found, written to stdout
 *   1 — no token in stdin
 *   2 — stdin read failed
 */
export async function runSlackExtractXoxc({
  flags,
  io,
}: {
  flags: SlackExtractFlags;
  io: SlackExtractIo;
}): Promise<number> {
  let input: string;
  try {
    input = await io.readStdin();
  } catch (e) {
    io.stderr.write(`slack-extract-xoxc: stdin read failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const token = findToken({ input });
  if (token === null) {
    io.stderr.write('slack-extract-xoxc: no xoxc token found in stdin.\n');
    return 1;
  }
  io.stdout.write(formatOutput({ token, format: flags.format }));
  return 0;
}
