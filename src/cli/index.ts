#!/usr/bin/env node
/**
 * `slopweaver <noun> <verb>` CLI.
 *
 * Thin dispatcher: resolve the noun/verb route against the registry, answer `--help` from the verb's
 * metadata without loading its module, then hand off to the verb's run function (fetched lazily). Each
 * command stays small and independently testable under src/cli/commands/.
 */
import { errorMessage } from '../lib/errorMessage.js'
import { logger } from '../lib/logger.js'
import { surfaceFailureHint } from './failureHint.js'
import { NOUN_GROUPS, NOUN_SUMMARIES } from './nounGroups.js'
import { isNoun, renderNounUsage, resolveNoun } from './router.js'
import { renderVerbHelp, wantsHelp } from './verbHelp.js'

export async function main(argv: readonly string[]): Promise<number> {
  const nounRoute = resolveNoun({ groups: NOUN_GROUPS, argv })
  if (nounRoute) {
    // `--help`/`-h` is answered here, before the handler runs: a manifest verb's usage rides on the
    // registry entry, so we print it WITHOUT loading the module. Help is not an error -> stdout, exit 0.
    if (nounRoute.kind === 'manifest') {
      if (wantsHelp({ argv })) {
        logger.out(renderVerbHelp({ meta: nounRoute.entry.meta }))
        return 0
      }
      const run = await nounRoute.entry.load()
      return await run(argv)
    }
    return await nounRoute.handler(argv)
  }
  if (isNoun({ groups: NOUN_GROUPS, argv })) {
    logger.error(`usage: slopweaver ${argv[2]} <verb>`)
    logger.error(renderNounUsage({ groups: NOUN_GROUPS, summaries: NOUN_SUMMARIES, only: argv[2] }))
    return 1
  }
  printUsage()
  return 1
}

function printUsage(): void {
  logger.error([
    'usage: slopweaver <noun> <verb> [--flags]',
    '',
    'noun groups:',
    renderNounUsage({ groups: NOUN_GROUPS, summaries: NOUN_SUMMARIES }),
  ].join('\n'))
}

const isDirectInvocation = import.meta.url.endsWith(process.argv[1] ?? '')
  || import.meta.url === `file://${process.argv[1] ?? ''}`
if (isDirectInvocation) {
  main(process.argv).then(
    (resolved) => {
      // SAFETY: normalise any non-finite code to a fault (1) so a failure can never be read as success.
      const code = typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : 1
      // Inline surfacer: print a one-line likely-cause+next-step AFTER the verb's own output when a known
      // failure signature matches. A no-op on success (code 0) or an unknown failure.
      if (code !== 0) {
        surfaceFailureHint({ argv: process.argv, code })
      }
      process.exit(code)
    },
    (error: unknown) => {
      logger.error(errorMessage({ error }))
      surfaceFailureHint({ argv: process.argv, code: 1, error })
      process.exit(1)
    },
  )
}
