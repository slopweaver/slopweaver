/**
 * Unit tests for the keychain bridge. Uses an in-memory `KeychainAdapter`
 * so the suite runs deterministically on Linux CI without depending on
 * libsecret / dbus availability. The real adapter is exercised by hand
 * (the smoke step in the PR description) on macOS.
 */

import { describe, expect, it, vi } from 'vitest';
import { type KeychainAdapter, deleteKeychainToken, loadKeychainToken, saveKeychainToken } from './keychain.ts';

function makeMemoryAdapter(): KeychainAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const key = ({ service, account }: { service: string; account: string }) => `${service}:${account}`;
  return {
    store,
    async setPassword({ service, account, password }) {
      store.set(key({ service, account }), password);
    },
    async getPassword({ service, account }) {
      return store.get(key({ service, account })) ?? null;
    },
    async deletePassword({ service, account }) {
      return store.delete(key({ service, account }));
    },
  };
}

describe('saveKeychainToken / loadKeychainToken', () => {
  it('round-trips a token via the same service/account', async () => {
    const adapter = makeMemoryAdapter();

    const saved = await saveKeychainToken({ integration: 'github', token: 'ghp_round_trip', adapter });
    expect(saved.isOk()).toBe(true);

    const loaded = await loadKeychainToken({ integration: 'github', adapter });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBe('ghp_round_trip');
    }

    expect(adapter.store.get('slopweaver:github')).toBe('ghp_round_trip');
  });

  it('returns Ok(null) when no entry exists for the integration', async () => {
    const adapter = makeMemoryAdapter();

    const loaded = await loadKeychainToken({ integration: 'slack', adapter });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });

  it('scopes lookups by integration slug', async () => {
    const adapter = makeMemoryAdapter();

    const saved = await saveKeychainToken({ integration: 'github', token: 'ghp_only_github', adapter });
    expect(saved.isOk()).toBe(true);

    const loaded = await loadKeychainToken({ integration: 'slack', adapter });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });
});

describe('deleteKeychainToken', () => {
  it('removes the entry so subsequent loads return Ok(null)', async () => {
    const adapter = makeMemoryAdapter();

    const saved = await saveKeychainToken({ integration: 'github', token: 'ghp_to_delete', adapter });
    expect(saved.isOk()).toBe(true);

    const deleted = await deleteKeychainToken({ integration: 'github', adapter });
    expect(deleted.isOk()).toBe(true);

    const loaded = await loadKeychainToken({ integration: 'github', adapter });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });
});

describe('keychain error surfacing', () => {
  it('save surfaces KEYCHAIN_WRITE_FAILED when the adapter rejects', async () => {
    const adapter: KeychainAdapter = {
      setPassword: vi.fn().mockRejectedValue(new Error('user denied keychain prompt')),
      getPassword: vi.fn(),
      deletePassword: vi.fn(),
    };

    const result = await saveKeychainToken({ integration: 'github', token: 'ghp_x', adapter });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('KEYCHAIN_WRITE_FAILED');
      expect(result.error.message).toContain('user denied keychain prompt');
    }
  });

  it('load surfaces KEYCHAIN_READ_FAILED when the adapter rejects', async () => {
    const adapter: KeychainAdapter = {
      setPassword: vi.fn(),
      getPassword: vi.fn().mockRejectedValue(new Error('keychain locked')),
      deletePassword: vi.fn(),
    };

    const result = await loadKeychainToken({ integration: 'github', adapter });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('KEYCHAIN_READ_FAILED');
      expect(result.error.message).toContain('keychain locked');
    }
  });

  it('delete surfaces KEYCHAIN_DELETE_FAILED when the adapter rejects', async () => {
    const adapter: KeychainAdapter = {
      setPassword: vi.fn(),
      getPassword: vi.fn(),
      deletePassword: vi.fn().mockRejectedValue(new Error('ambiguous credential')),
    };

    const result = await deleteKeychainToken({ integration: 'github', adapter });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('KEYCHAIN_DELETE_FAILED');
      expect(result.error.message).toContain('ambiguous credential');
    }
  });
});
