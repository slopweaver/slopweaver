/**
 * The PreToolUse hook's runner (effectful core, testable). Reads the tool-call payload, evaluates it, and
 * returns the exit code (2 = block, 0 = allow). FAIL-CLOSED: a malformed payload blocks loudly rather than
 * silently allowing, and a thrown evaluation error is left to reject so the thin entry's top-level catch
 * exits 2 — no silent fail-open. `readStdin`/`env`/`writeError`/`evaluate` are injected so this is unit-tested.
 */
import { evaluateHookPayload } from './hookPayload.js'

/** Read all of stdin to a string. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
    process.stdin.on('end', () => { resolve(data) })
    process.stdin.on('error', () => { resolve(data) })
  })
}

/**
 * Run the hook: read + parse the payload, evaluate, and return the exit code. Blocks (2) on a malformed
 * payload or a blocked command; allows (0) otherwise. A thrown `evaluate` error propagates (fail closed at
 * the entry).
 *
 * @param readStdin reads the raw payload
 * @param env the environment (for `SLOPWEAVER_ALLOW_RAW`)
 * @param writeError writes a diagnostic line (to stderr in production)
 * @param evaluate the pure payload evaluator (defaults to {@link evaluateHookPayload})
 * @returns the exit code (2 block, 0 allow)
 */
export async function runPreToolUseAdmit(
  { readStdin: read, env, writeError, evaluate = evaluateHookPayload }: {
    readStdin: () => Promise<string>
    env: Readonly<Record<string, string | undefined>>
    writeError: (line: string) => void
    evaluate?: typeof evaluateHookPayload
  },
): Promise<number> {
  let payload: unknown
  try {
    payload = JSON.parse(await read())
  } catch {
    writeError('pretooluse-admit: malformed PreToolUse JSON payload — blocking (fail closed)\n')
    return 2
  }
  const decision = evaluate({ payload, allowRaw: env.SLOPWEAVER_ALLOW_RAW === '1' })
  if (decision.block) {
    writeError(`${decision.message}\n`)
    return 2
  }
  return 0
}
