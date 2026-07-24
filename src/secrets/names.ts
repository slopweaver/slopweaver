/**
 * The connector-secret NAME allowlist. A secret is written to `$SLOPWEAVER_HOME/secrets/<name>`, so the
 * name is a filename fragment an attacker-shaped input must never smuggle a path traversal through. Only
 * the five names the token chain in `config.ts` actually reads are accepted; anything else (an unknown
 * name, a `../` escape, a name with a slash) is a hard parse error, never a write.
 *
 * Pure: no I/O. The set here is the single source of truth `secrets set` validates against and matches the
 * `secretName` literals `slackUserToken`/`slackBotToken`/`linearToken`/`notionToken`/`githubToken` resolve.
 */
import { err, ok, type Result } from "../lib/result.js";

/** The connector tokens a user can persist. Mirrors the `secretName` literals in `config.ts`. */
export type SecretName = "github-token" | "slack-user-token" | "slack-bot-token" | "linear-token" | "notion-token";

/** The accepted secret names, in a stable display order (used by `--help` + the onboard guidance). */
export const SECRET_NAMES: readonly SecretName[] = [
  "github-token",
  "slack-user-token",
  "slack-bot-token",
  "linear-token",
  "notion-token",
] as const;

/**
 * Validate a raw name against the allowlist. Rejects unknown names AND any traversal shape (a `/`, a `\`,
 * or a `.` segment) even if it somehow matched — defence in depth so the resolved path can only ever be a
 * direct child of `secrets/`. Pure.
 *
 * @param value the raw `<name>` argument
 * @returns the typed secret name, or an error listing the accepted names
 */
export function parseSecretName({ value }: { value: string }): Result<SecretName> {
  const trimmed = value.trim();
  if (/[/\\]/.test(trimmed) || trimmed.includes("..")) {
    return err([`invalid secret name (no path separators): ${value}`]);
  }
  if (!SECRET_NAMES.includes(trimmed as SecretName)) {
    return err([`unknown secret name: ${value} (expected ${SECRET_NAMES.join(" | ")})`]);
  }
  return ok(trimmed as SecretName);
}
