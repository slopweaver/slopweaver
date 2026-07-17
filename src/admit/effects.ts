/**
 * `throughDoor` — the seam every future side-effecting verb (PR5+) wraps its effect in. It admits the
 * request, RECORDS the decision, and performs the effect ONLY on `pass`; on `warn`/`hold` it performs
 * nothing and hands the decision back so the caller can surface the self-correctable findings. No verb
 * uses it yet (slopweaver is read-only), so in PR2 it is a tested, no-op-safe contract — the guarantee
 * that when actions arrive they are gated by construction.
 */
import { randomUUID } from 'node:crypto'

import { admitDoor } from './door.js'
import { recordDoorDecision } from './ledger.js'
import type { DoorDecision, DoorGate, DoorRequest } from './types.js'

/**
 * The outcome of routing an effect through the door — a discriminated union so `result` EXISTS iff the
 * effect actually ran (`performed: true`). A caller can't read a `result` that never happened.
 */
export type ThroughDoorResult<T> =
  | { readonly decision: DoorDecision; readonly performed: true; readonly result: T }
  | { readonly decision: DoorDecision; readonly performed: false }

/**
 * Route a side effect through the door: admit → record → perform only on `pass`. `gates` is REQUIRED (the
 * caller states its policy explicitly — pass `DEFAULT_GATES` for none). `env`/`home`/`runId`/`nowIso` stay
 * optional at this runtime edge because their defaults are real behaviour (the live env / a fresh id / now),
 * not type appeasement. `perform` is the caller's effect thunk.
 *
 * @param request the action + artifact + meta
 * @param perform the effect to run only if the door passes
 * @param gates the gate list (pass `DEFAULT_GATES` for the empty compose seam)
 * @param env the environment (for the override token; defaults to `process.env`)
 * @param home the state home for the ledger (defaults to the resolved home)
 * @param runId the run id to record (defaults to a fresh uuid)
 * @param nowIso the timestamp to record (defaults to now)
 * @returns the decision + whether the effect ran + (iff it ran) its result
 */
export async function throughDoor<T>(
  { request, perform, gates, env = process.env, home, runId, nowIso }: {
    request: DoorRequest
    perform: () => Promise<T> | T
    gates: readonly DoorGate[]
    env?: Readonly<Record<string, string | undefined>>
    home?: string
    runId?: string
    nowIso?: string
  },
): Promise<ThroughDoorResult<T>> {
  const decision = admitDoor({ request, env, gates })
  recordDoorDecision({
    request,
    decision,
    runId: runId ?? randomUUID(),
    tsIso: nowIso ?? new Date().toISOString(),
    ...(home !== undefined ? { home } : {}),
  })
  if (decision.status === 'pass') {
    return { decision, performed: true, result: await perform() }
  }
  return { decision, performed: false }
}
