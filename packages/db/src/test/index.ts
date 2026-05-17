/**
 * Test-only helpers exported from `@slopweaver/db/test`.
 *
 * Subpath kept separate from the main `@slopweaver/db` runtime export so
 * production code can't reach for these by accident. Mirrors the
 * `@slopweaver/integrations-core/test-setup/polly` pattern already in use.
 */

import type { KeychainAdapter } from '../keychain.ts';

export type InMemoryKeychainAdapter = KeychainAdapter & {
  readonly store: Map<string, string>;
};

/**
 * Returns an isolated, in-memory `KeychainAdapter` for tests. Each call
 * creates a fresh `Map`, so per-test instantiation (typically in
 * `beforeEach`) keeps state from leaking between tests.
 *
 * The returned `.store` is exposed for tests that need to assert directly
 * on stored values — most callers only need the adapter to inject into
 * `saveIntegrationToken` / `loadIntegrationToken`.
 */
export function createInMemoryKeychainAdapter(): InMemoryKeychainAdapter {
  const store = new Map<string, string>();
  const key = ({ service, account }: { service: string; account: string }): string => `${service}:${account}`;
  return {
    store,
    setPassword: async ({ service, account, password }) => {
      store.set(key({ service, account }), password);
    },
    getPassword: async ({ service, account }) => store.get(key({ service, account })) ?? null,
    deletePassword: async ({ service, account }) => store.delete(key({ service, account })),
  };
}
