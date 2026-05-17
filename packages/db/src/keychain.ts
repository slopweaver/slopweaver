/**
 * OS keychain bridge for integration access tokens.
 *
 * Tokens for `slopweaver connect github` / `connect slack` live in the
 * macOS Keychain (and equivalents on Linux/Windows via libsecret /
 * Credential Manager). The `integration_tokens` SQLite row tracks
 * *presence* (slug, account label, timestamps); the secret itself never
 * touches disk in plaintext. See `.claude/rules/error-handling.md` —
 * `packages/db/src/**` is service-boundary scanned, so every keychain
 * call is wrapped with `ResultAsync.fromPromise` rather than `try/catch`.
 *
 * The `KeychainAdapter` indirection exists so tests can swap in a memory
 * fake without depending on libsecret / dbus availability in CI. The
 * `realKeychainAdapter` default wraps `@napi-rs/keyring`'s `AsyncEntry`,
 * which catches the underlying Rust `NoEntry` error and returns
 * `undefined` on a miss — we normalize that to `null` so callers see a
 * uniform `string | null`.
 */

import { AsyncEntry } from '@napi-rs/keyring';
import type { BaseError } from '@slopweaver/errors';
import { ResultAsync } from '@slopweaver/errors';

const KEYCHAIN_SERVICE = 'slopweaver';

export interface KeychainWriteFailedError extends BaseError {
  readonly code: 'KEYCHAIN_WRITE_FAILED';
  readonly cause: unknown;
}

export interface KeychainReadFailedError extends BaseError {
  readonly code: 'KEYCHAIN_READ_FAILED';
  readonly cause: unknown;
}

export interface KeychainDeleteFailedError extends BaseError {
  readonly code: 'KEYCHAIN_DELETE_FAILED';
  readonly cause: unknown;
}

export type KeychainError = KeychainWriteFailedError | KeychainReadFailedError | KeychainDeleteFailedError;

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown keychain failure';
}

export const KeychainErrors = {
  writeFailed: (cause: unknown): KeychainWriteFailedError => ({
    code: 'KEYCHAIN_WRITE_FAILED',
    message: `Failed to write token to keychain: ${describe(cause)}`,
    cause,
  }),
  readFailed: (cause: unknown): KeychainReadFailedError => ({
    code: 'KEYCHAIN_READ_FAILED',
    message: `Failed to read token from keychain: ${describe(cause)}`,
    cause,
  }),
  deleteFailed: (cause: unknown): KeychainDeleteFailedError => ({
    code: 'KEYCHAIN_DELETE_FAILED',
    message: `Failed to delete token from keychain: ${describe(cause)}`,
    cause,
  }),
} as const;

export interface KeychainAdapter {
  setPassword(args: { service: string; account: string; password: string }): Promise<void>;
  getPassword(args: { service: string; account: string }): Promise<string | null>;
  deletePassword(args: { service: string; account: string }): Promise<boolean>;
}

export const realKeychainAdapter: KeychainAdapter = {
  async setPassword({ service, account, password }) {
    const entry = new AsyncEntry(service, account);
    await entry.setPassword(password);
  },
  async getPassword({ service, account }) {
    const entry = new AsyncEntry(service, account);
    const value = await entry.getPassword();
    return value ?? null;
  },
  async deletePassword({ service, account }) {
    const entry = new AsyncEntry(service, account);
    return entry.deleteCredential();
  },
};

/**
 * Stores `token` under the keychain entry `slopweaver / <integration>`,
 * overwriting any previous value. Returns Err if the underlying keychain
 * call rejects (typically: user denied Keychain Access, locked keychain
 * with no UI to prompt, or a platform-side `Ambiguous` credential).
 */
export function saveKeychainToken({
  integration,
  token,
  adapter = realKeychainAdapter,
}: {
  integration: string;
  token: string;
  adapter?: KeychainAdapter;
}): ResultAsync<void, KeychainWriteFailedError> {
  return ResultAsync.fromPromise(
    adapter.setPassword({ service: KEYCHAIN_SERVICE, account: integration, password: token }),
    KeychainErrors.writeFailed,
  );
}

/**
 * Reads the token from the keychain entry `slopweaver / <integration>`.
 * Returns `Ok(null)` when no entry exists — callers should treat that as
 * "not connected" (same convention as `loadIntegrationToken`'s
 * missing-row case). Returns Err only when the keychain call itself
 * fails (denied prompt, locked keychain, etc.).
 */
export function loadKeychainToken({
  integration,
  adapter = realKeychainAdapter,
}: {
  integration: string;
  adapter?: KeychainAdapter;
}): ResultAsync<string | null, KeychainReadFailedError> {
  return ResultAsync.fromPromise(
    adapter.getPassword({ service: KEYCHAIN_SERVICE, account: integration }),
    KeychainErrors.readFailed,
  );
}

/**
 * Removes the keychain entry for `integration`. Returning `Ok` for a
 * missing entry vs an actually-deleted entry is intentionally not
 * distinguished — the boolean from the underlying lib is discarded.
 */
export function deleteKeychainToken({
  integration,
  adapter = realKeychainAdapter,
}: {
  integration: string;
  adapter?: KeychainAdapter;
}): ResultAsync<void, KeychainDeleteFailedError> {
  return ResultAsync.fromPromise(
    adapter.deletePassword({ service: KEYCHAIN_SERVICE, account: integration }),
    KeychainErrors.deleteFailed,
  ).map(() => undefined);
}
