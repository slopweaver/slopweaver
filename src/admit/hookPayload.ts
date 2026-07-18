/**
 * The pure core of the PreToolUse hook: decide, from a tool-call payload, whether to block a raw-bypass
 * `Bash` command. Lives in `src/admit/` (not the hook file) so it is unit-tested like the rest of the door;
 * `hooks/pretooluse-admit.ts` is the thin effectful shell that reads stdin + env and sets the exit code.
 */
import { isRecord } from "../lib/parsers.js";
import { classifyRawCommand } from "./rawTools.js";

/** The hook's decision — a discriminated union so a `block` ALWAYS carries a message (no optional fallback). */
export type HookDecision = { readonly block: true; readonly message: string } | { readonly block: false };

/**
 * Decide a PreToolUse payload. FAIL-CLOSED: a malformed payload (not an object) or a `Bash` call missing
 * its `command` blocks loudly rather than passing. A well-formed NON-Bash tool call is allowed (we only
 * police Bash). A `Bash` command is blocked only when the raw classifier says so.
 *
 * @param payload the parsed PreToolUse JSON (`{ tool_name, tool_input: { command } }`)
 * @param allowRaw whether `SLOPWEAVER_ALLOW_RAW=1` is set
 * @returns the block/allow decision
 */
export function evaluateHookPayload({ payload, allowRaw }: { payload: unknown; allowRaw: boolean }): HookDecision {
  if (!isRecord(payload)) {
    return {
      block: true,
      message: "pretooluse-admit: malformed PreToolUse payload (not an object) — blocking (fail closed)",
    };
  }
  if (payload["tool_name"] !== "Bash") {
    return { block: false };
  }
  const input = payload["tool_input"];
  if (!isRecord(input) || typeof input["command"] !== "string") {
    return {
      block: true,
      message: "pretooluse-admit: Bash payload is missing tool_input.command — blocking (fail closed)",
    };
  }
  const verdict = classifyRawCommand({ allowRaw, command: input["command"] });
  return verdict.blocked ? { block: true, message: verdict.message } : { block: false };
}
