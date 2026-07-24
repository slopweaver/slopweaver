/**
 * The shared shape of a `connect <source> --check` preflight report, plus the two pure report-finalisers
 * every per-source classifier ends on. A report is a deterministic, value-free description of what a token
 * can reach: whether auth succeeded, which scopes/capabilities are present, and whether a 1-item read saw
 * real data. It NEVER carries a token, an email, or a raw payload — only capability verdicts and hints —
 * so `--json` is safe to print into the (transcript-visible) slash-command output.
 *
 * Pure: no I/O. The effectful probes live in the per-source modules; here is only the type + the ok-rule.
 */

/** The four sources a preflight can run against. */
export type ConnectSource = "github" | "slack" | "linear" | "notion";

/** One capability's verdict: present, present-but-reduced, or absent (a hard gap that fails the check). */
export type CapabilityStatus = "ok" | "warning" | "missing";

/** One named capability the source needs, with its verdict and a human hint (never a value). */
export interface ConnectCapability {
  /** Stable id the slash command / tests branch on (e.g. `auth`, `scope:users:read.email`, `read-probe`). */
  readonly id: string;
  readonly status: CapabilityStatus;
  /** A short why/how — the hint to fix a gap. Never contains a token, email, or raw payload. */
  readonly detail: string;
}

/** A whole source's preflight verdict. `ok` ⇒ every required capability present + reachable. */
export interface ConnectCheckReport {
  readonly source: ConnectSource;
  readonly ok: boolean;
  readonly tokenPresent: boolean;
  readonly capabilities: readonly ConnectCapability[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Finalise a report: `ok` iff the token is present, no capability is `missing`, and no hard error was
 * recorded. A `warning` capability (reduced breadth) still passes — the user can proceed knowingly. Pure.
 *
 * @param source the source
 * @param tokenPresent whether a token was resolved for the source
 * @param capabilities the per-capability verdicts
 * @param warnings reduced-breadth notes
 * @param errors hard failures (auth unreachable, etc.)
 * @returns the finalised report with `ok` computed
 */
export function finaliseReport({
  source,
  tokenPresent,
  capabilities,
  warnings = [],
  errors = [],
}: {
  source: ConnectSource;
  tokenPresent: boolean;
  capabilities: readonly ConnectCapability[];
  warnings?: readonly string[];
  errors?: readonly string[];
}): ConnectCheckReport {
  const hasMissing = capabilities.some((c) => c.status === "missing");
  return {
    capabilities,
    errors,
    ok: tokenPresent && errors.length === 0 && !hasMissing,
    source,
    tokenPresent,
    warnings,
  };
}

/**
 * The report for a source with no token configured — a single `missing` auth capability carrying the hint
 * on how to set it. Pure.
 *
 * @param source the source
 * @param hint how to provide the token (env var / `secrets set` name)
 * @returns a not-ok, no-token report
 */
export function noTokenReport({ source, hint }: { source: ConnectSource; hint: string }): ConnectCheckReport {
  return finaliseReport({
    capabilities: [{ detail: hint, id: "auth", status: "missing" }],
    errors: [`no ${source} token configured`],
    source,
    tokenPresent: false,
  });
}
