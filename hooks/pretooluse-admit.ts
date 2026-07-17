/**
 * PreToolUse hook entry point — nothing but the top-level invocation. Claude Code pipes each tool call to
 * this file's stdin BEFORE it runs; the logic (fail-closed raw-tool guard) lives in
 * `src/admit/pretooluseAdmit.ts` (+ `hookPayload.ts`), which are unit-tested. This file existing IS the
 * invocation, so there is no `isDirectInvocation` guard — and an unhandled error exits 2 (fail closed),
 * never a silent allow.
 */
import { errorMessage } from '../src/lib/errorMessage.js'
import { readStdin, runPreToolUseAdmit } from '../src/admit/pretooluseAdmit.js'

runPreToolUseAdmit({
  readStdin,
  env: process.env,
  writeError: (line) => { process.stderr.write(line) },
}).then(
  (code) => { process.exit(code) },
  (error: unknown) => {
    process.stderr.write(`pretooluse-admit: ${errorMessage({ error })} — blocking (fail closed)\n`)
    process.exit(2)
  },
)
