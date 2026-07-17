/**
 * The door itself — the pure decision engine every side-effecting action passes through. It runs the
 * ordered gate list (EMPTY in PR2 — the compose seam later PRs fill), applies any explicit per-action
 * override, and returns `pass` / `warn` / `hold`. No I/O: `ledger.ts` records the decision, the caller
 * (a future verb, via `effects.ts`) performs the effect only on `pass`.
 *
 * Warn-first, never silent (D9): a gate's `warn` is returned as a structured, self-correctable finding
 * the agent sees and can re-issue past with `$SLOPWEAVER_DOOR_OVERRIDE=<token>`; a `hold` is the
 * irreversible-harm core and is NOT waivable by that per-action token.
 */
import type { DoorDecision, DoorFinding, DoorGate, DoorRequest, DoorStatus } from './types.js'

/** The empty compose seam. PR2 ships zero real gates on purpose; PR9/PR14 append to a caller's gate list. */
export const DEFAULT_GATES: readonly DoorGate[] = []

/** Whether `$SLOPWEAVER_DOOR_OVERRIDE` (a comma-separated token list) carries this warn's override token. */
function isOverridden({ token, overrideEnv }: { token: string; overrideEnv: string | undefined }): boolean {
  if (overrideEnv === undefined) {
    return false
  }
  return overrideEnv.split(',').map((t) => t.trim()).includes(token)
}

/**
 * Decide a request: run the gates, waive overridden `warn` findings (recording them), and fold the rest
 * into a status — `hold` if any survives, else `warn` if any survives, else `pass`. Pure: `env` and
 * `gates` are injected — `gates` is REQUIRED (pass the exported {@link DEFAULT_GATES} for "no gates"), so a
 * caller never accidentally admits an ungated action by omission.
 *
 * @param request the action + artifact + meta being admitted
 * @param env the environment (read only for the override token)
 * @param gates the ordered gate list (pass {@link DEFAULT_GATES} for the empty compose seam)
 * @returns the decision: status + surviving findings + the findings an override waived
 */
export function admitDoor(
  { request, env, gates }: {
    request: DoorRequest
    env: Readonly<Record<string, string | undefined>>
    gates: readonly DoorGate[]
  },
): DoorDecision {
  const overrideEnv = env.SLOPWEAVER_DOOR_OVERRIDE
  const overridden: DoorFinding[] = []
  const active: DoorFinding[] = []
  for (const finding of gates.flatMap((gate) => gate(request))) {
    if (finding.severity === 'warn' && isOverridden({ token: finding.override, overrideEnv })) {
      overridden.push(finding)
    } else {
      active.push(finding)
    }
  }
  const status: DoorStatus = active.some((f) => f.severity === 'hold')
    ? 'hold'
    : active.some((f) => f.severity === 'warn')
      ? 'warn'
      : 'pass'
  return { status, findings: active, overridden }
}
