/**
 * `slopweaver <noun> <verb>` CLI logic. Kept in a MODULE (not the entry file) so the whole dispatch spine
 * is importable + testable; `cli/index.ts` is the tiny top-level entry that just runs `runCliProcess`. No
 * `isDirectInvocation` guard anywhere — the entry file IS the invocation.
 *
 * Thin dispatcher: resolve the noun/verb route against the registry, answer `--help` from the verb's
 * metadata without loading its module, then hand off to the verb's run function (fetched lazily).
 */
import { errorMessage } from "../lib/errorMessage.js";
import { logger } from "../lib/logger.js";
import { surfaceFailureHint } from "./failureHint.js";
import { NOUN_GROUPS, NOUN_SUMMARIES } from "./nounGroups.js";
import { isNoun, renderNounUsage, resolveNoun } from "./router.js";
import { renderVerbHelp, wantsHelp } from "./verbHelp.js";

/**
 * Resolve + run one CLI invocation to an exit code. Pure of process concerns (no exit, no argv default) —
 * `runCliProcess` owns those.
 *
 * @param argv the full process argv ([node, cli, noun, verb, …])
 * @returns the process exit code
 */
export async function main(argv: readonly string[]): Promise<number> {
  const nounRoute = resolveNoun({ argv, groups: NOUN_GROUPS });
  if (nounRoute) {
    // `--help`/`-h` is answered here, before the handler runs: a manifest verb's usage rides on the
    // registry entry, so we print it WITHOUT loading the module. Help is not an error -> stdout, exit 0.
    if (nounRoute.kind === "manifest") {
      if (wantsHelp({ argv })) {
        logger.out(renderVerbHelp({ meta: nounRoute.entry.meta }));
        return 0;
      }
      const run = await nounRoute.entry.load();
      return run(argv);
    }
    return nounRoute.handler(argv);
  }
  if (isNoun({ argv, groups: NOUN_GROUPS })) {
    const only = argv[2];
    logger.error(`usage: slopweaver ${only} <verb>`);
    logger.error(
      renderNounUsage({
        groups: NOUN_GROUPS,
        ...(only !== undefined ? { only } : {}),
        summaries: NOUN_SUMMARIES,
      }),
    );
    return 1;
  }
  printUsage();
  return 1;
}

function printUsage(): void {
  logger.error(
    [
      "usage: slopweaver <noun> <verb> [--flags]",
      "",
      "noun groups:",
      renderNounUsage({ groups: NOUN_GROUPS, summaries: NOUN_SUMMARIES }),
    ].join("\n"),
  );
}

/**
 * The process shell: run `main`, normalise the code, surface a failure hint, and exit. `argv`/`exit` are
 * injectable so this is testable without spawning; their defaults are the real runtime values.
 *
 * @param argv the process argv (defaults to `process.argv`)
 * @param exit the exit function (defaults to `process.exit`)
 */
export async function runCliProcess({
  argv = process.argv,
  exit = process.exit,
}: {
  argv?: readonly string[];
  exit?: (code: number) => void;
} = {}): Promise<void> {
  try {
    const resolved = await main(argv);
    // SAFETY: normalise any non-finite code to a fault (1) so a failure can never be read as success.
    const code = typeof resolved === "number" && Number.isFinite(resolved) ? resolved : 1;
    // Inline surfacer: a one-line likely-cause + next-step AFTER the verb's output on a known failure.
    if (code !== 0) {
      surfaceFailureHint({ argv, code });
    }
    exit(code);
  } catch (error: unknown) {
    logger.error(errorMessage({ error }));
    surfaceFailureHint({ argv, code: 1, error });
    exit(1);
  }
}
