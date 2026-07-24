/**
 * The connector-secret WRITER — the one place a token lands on disk. It writes
 * `$SLOPWEAVER_HOME/secrets/<name>` at `0600` under a `0700` `secrets/` dir, enforcing both modes on
 * create AND on overwrite (a mode is umask-masked on create and never tightens an existing file). The
 * token value is NEVER logged, echoed, or returned — the result carries only the name + path + a written
 * flag, so a caller can report success without ever holding the value again.
 *
 * The value arrives from a no-echo/piped source (never argv); {@link normaliseSecretInput} strips the one
 * trailing newline a shell pipe adds and rejects a blank or multi-line value. The fs edge is thin over the
 * pure {@link normaliseSecretInput}; it is exercised by a temp-dir round-trip (a genuine fixture, no mock).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { err, ok, type Result } from "../lib/result.js";
import { secretFilePath, stateHomePaths } from "../stateHome.js";
import type { SecretName } from "./names.js";

/** The outcome of a secret write — deliberately value-free so success is reportable without the token. */
export interface SecretWriteResult {
  readonly name: SecretName;
  readonly path: string;
  readonly written: true;
}

/**
 * Normalise a raw captured value: strip a single trailing `\r?\n` (the newline a shell pipe/`read` adds),
 * then reject a blank or multi-line value (a token is exactly one non-empty line). Pure — never trims
 * interior characters, so a token that legitimately contains no whitespace round-trips byte-for-byte.
 *
 * @param input the raw captured value (from piped stdin / a no-echo read)
 * @returns the cleaned single-line token, or an error
 */
export function normaliseSecretInput({ input }: { input: string }): Result<string> {
  const value = input.replace(/\r?\n$/, "");
  if (value.length === 0) {
    return err(["empty secret value — nothing to write"]);
  }
  if (/[\r\n]/.test(value)) {
    return err(["secret value spans multiple lines — expected a single-line token"]);
  }
  return ok(value);
}

/**
 * Write a validated token to its secret file at `0600` (dir `0700`). Idempotent by content: writing the
 * same value twice leaves the same file at the same path. Overwriting replaces the value and re-tightens
 * the mode. Never logs the value. Returns a value-free result.
 *
 * @param home the world-model home
 * @param name the allowlisted secret name
 * @param value the normalised single-line token
 * @returns the write result (name + path only), or an fs error
 */
export function writeSecretFile({
  home,
  name,
  value,
}: {
  home: string;
  name: SecretName;
  value: string;
}): Result<SecretWriteResult> {
  const dir = stateHomePaths({ home }).secrets;
  const path = secretFilePath({ home, name });
  try {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    chmodSync(dir, 0o700);
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error: unknown) {
    return err([`could not write secret ${name}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return ok({ name, path, written: true });
}
