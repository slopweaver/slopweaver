/**
 * `slopweaver demo` — print a synthetic /session-start snapshot to
 * stdout. Zero-friction try-before-BYOK: a stranger can run this
 * after `npm install -g slopweaver` and see what a populated
 * snapshot looks like without connecting Slack / GitHub / Gmail /
 * anything.
 *
 * v1.1 first cut is a canned snapshot (the synthetic-persona
 * string). A v1.2 follow-up replaces this with a cassette-replay of
 * a real cold-start against a fixture workspace, so the output
 * varies a little run-to-run and feels more authentic. The CLI
 * surface stays the same — only the data source changes.
 */

import { DEMO_SNAPSHOT } from './synthetic-persona.ts';

export type RunDemoDeps = {
  stdout: { write: (s: string) => void };
};

export async function runDemo(deps: RunDemoDeps): Promise<number> {
  deps.stdout.write(DEMO_SNAPSHOT);
  return 0;
}
