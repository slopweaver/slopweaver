/**
 * Render a {@link ConnectCheckReport} for humans (a line-based report, like `doctor`) or for the slash
 * command (`--json` — the report object verbatim, already value-free + stable-keyed). Pure: no I/O, no
 * clock; the report never carries a token/email/payload, so both renderings are transcript-safe.
 */
import type { CapabilityStatus, ConnectCheckReport } from "./types.js";

/** The status glyph for the text report — a stable ASCII marker per verdict. */
const STATUS_MARK: Record<CapabilityStatus, string> = { missing: "✗", ok: "✓", warning: "!" };

/**
 * Render the human report lines: a headline verdict, then one line per capability, then any warnings/errors.
 *
 * @param report the finalised preflight report
 * @returns the report lines, in display order
 */
export function renderConnectText({ report }: { report: ConnectCheckReport }): readonly string[] {
  const headline = report.ok ? "OK" : "NOT READY";
  const lines = [`connect ${report.source}: ${headline}`];
  for (const cap of report.capabilities) {
    lines.push(`  ${STATUS_MARK[cap.status]} ${cap.id}: ${cap.detail}`);
  }
  for (const warning of report.warnings) {
    lines.push(`  ! ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`  ✗ ${error}`);
  }
  return lines;
}

/**
 * Render the machine-readable report the slash command branches on. Stable key order (via the typed
 * object), value-free.
 *
 * @param report the finalised preflight report
 * @returns the JSON string
 */
export function renderConnectJson({ report }: { report: ConnectCheckReport }): string {
  return JSON.stringify(
    {
      capabilities: report.capabilities,
      errors: report.errors,
      ok: report.ok,
      source: report.source,
      tokenPresent: report.tokenPresent,
      warnings: report.warnings,
    },
    null,
    2,
  );
}
