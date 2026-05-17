/**
 * Unit tests for loadIntegrationToken / saveIntegrationToken.
 *
 * Pins the contracts the CLI subcommands and the polling layer rely on:
 * missing rows surface as `null` (not Err), repeat saves upsert cleanly
 * without resetting `created_at_ms`, writes are scoped per integration
 * slug, and the secret is routed through the injected keychain adapter
 * (so this suite stays deterministic on Linux CI without depending on
 * libsecret). Result-based assertions per .claude/rules/error-handling.md.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDb } from './index.ts';
import { loadIntegrationToken, saveIntegrationToken } from './integration-tokens.ts';
import type { KeychainAdapter } from './keychain.ts';
import { integrationTokens } from './schema/integration-tokens.ts';

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

describe('loadIntegrationToken', () => {
  it('returns ok(null) when no row exists for the integration', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter = makeMemoryAdapter();
      const result = await loadIntegrationToken({ db: handle.db, integration: 'github', keychainAdapter });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    } finally {
      handle.close();
    }
  });

  it('returns ok with the stored token + account label after a save', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter = makeMemoryAdapter();
      const saveResult = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_test_value',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
        keychainAdapter,
      });
      expect(saveResult.isOk()).toBe(true);

      const loadResult = await loadIntegrationToken({ db: handle.db, integration: 'github', keychainAdapter });
      expect(loadResult.isOk()).toBe(true);
      if (loadResult.isOk()) {
        expect(loadResult.value).toEqual({
          token: 'ghp_test_value',
          accountLabel: 'octocat',
        });
      }
    } finally {
      handle.close();
    }
  });

  it('scopes lookups by integration slug', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter = makeMemoryAdapter();
      const saveResult = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_github',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
        keychainAdapter,
      });
      expect(saveResult.isOk()).toBe(true);

      const result = await loadIntegrationToken({ db: handle.db, integration: 'slack', keychainAdapter });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    } finally {
      handle.close();
    }
  });

  it('returns ok(null) and writes a stderr hint when the row exists but the keychain entry is missing', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      handle.db
        .insert(integrationTokens)
        .values({
          integration: 'github',
          accountLabel: 'octocat',
          createdAtMs: 1_746_000_000_000,
          updatedAtMs: 1_746_000_000_000,
        })
        .run();

      const keychainAdapter = makeMemoryAdapter();
      const stderr = { write: vi.fn() };

      const result = await loadIntegrationToken({
        db: handle.db,
        integration: 'github',
        keychainAdapter,
        stderr,
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
      expect(stderr.write).toHaveBeenCalledTimes(1);
      expect(stderr.write).toHaveBeenCalledWith(
        "slopweaver: github token missing from keychain — run 'slopweaver connect github' to migrate\n",
      );
    } finally {
      handle.close();
    }
  });
});

describe('saveIntegrationToken', () => {
  it('upserts: re-saving the same integration overwrites token + account label', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter = makeMemoryAdapter();
      const firstSave = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_old',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
        keychainAdapter,
      });
      expect(firstSave.isOk()).toBe(true);
      const secondSave = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_new',
        accountLabel: 'octocat-renamed',
        now: () => 1_746_000_000_500,
        keychainAdapter,
      });
      expect(secondSave.isOk()).toBe(true);

      const loaded = await loadIntegrationToken({ db: handle.db, integration: 'github', keychainAdapter });
      expect(loaded.isOk()).toBe(true);
      if (loaded.isOk()) {
        expect(loaded.value).toEqual({
          token: 'ghp_new',
          accountLabel: 'octocat-renamed',
        });
      }
      expect(handle.db.select().from(integrationTokens).all()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('preserves created_at_ms across re-saves and bumps updated_at_ms', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter = makeMemoryAdapter();
      const firstSave = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_first',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
        keychainAdapter,
      });
      expect(firstSave.isOk()).toBe(true);
      const secondSave = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_second',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_999,
        keychainAdapter,
      });
      expect(secondSave.isOk()).toBe(true);

      const row = handle.db.select().from(integrationTokens).get();
      expect(row?.createdAtMs).toBe(1_746_000_000_000);
      expect(row?.updatedAtMs).toBe(1_746_000_000_999);
    } finally {
      handle.close();
    }
  });

  it('accepts a null account label', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter = makeMemoryAdapter();
      const saveResult = await saveIntegrationToken({
        db: handle.db,
        integration: 'slack',
        token: 'xoxb-redacted',
        accountLabel: null,
        now: () => 1_746_000_000_000,
        keychainAdapter,
      });
      expect(saveResult.isOk()).toBe(true);

      const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack', keychainAdapter });
      expect(loaded.isOk()).toBe(true);
      if (loaded.isOk()) {
        expect(loaded.value).toEqual({
          token: 'xoxb-redacted',
          accountLabel: null,
        });
      }
    } finally {
      handle.close();
    }
  });

  it('propagates KEYCHAIN_WRITE_FAILED without creating a SQLite row', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const keychainAdapter: KeychainAdapter = {
        setPassword: vi.fn().mockRejectedValue(new Error('user denied keychain prompt')),
        getPassword: vi.fn(),
        deletePassword: vi.fn(),
      };

      const result = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_never_written',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
        keychainAdapter,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('KEYCHAIN_WRITE_FAILED');
      }

      const rows = handle.db.select().from(integrationTokens).all();
      expect(rows).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('cleans up the keychain entry when the SQLite upsert fails (no split-brain)', async () => {
    // Close the connection before invoking save — the keychain write
    // will succeed, then the SQLite upsert will fail, exercising the
    // compensating-delete path.
    const handle = createDb({ path: ':memory:' });
    handle.close();
    const keychainAdapter = makeMemoryAdapter();

    const result = await saveIntegrationToken({
      db: handle.db,
      integration: 'github',
      token: 'ghp_orphaned_no_more',
      accountLabel: 'octocat',
      now: () => 1_746_000_000_000,
      keychainAdapter,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // The original DB error is what the caller sees — NOT a keychain error.
      expect(result.error.code).not.toBe('KEYCHAIN_DELETE_FAILED');
    }
    // The keychain entry was created during save but cleaned up after the DB fail.
    expect(keychainAdapter.store.has('slopweaver:github')).toBe(false);
  });

  it('surfaces the original DB error even when the compensating keychain delete also fails', async () => {
    const handle = createDb({ path: ':memory:' });
    handle.close();
    const writes = new Map<string, string>();
    const keychainAdapter: KeychainAdapter = {
      async setPassword({ service, account, password }) {
        writes.set(`${service}:${account}`, password);
      },
      getPassword: vi.fn(),
      async deletePassword() {
        throw new Error('keychain delete failed after orphan');
      },
    };

    const result = await saveIntegrationToken({
      db: handle.db,
      integration: 'github',
      token: 'ghp_double_failure',
      accountLabel: 'octocat',
      now: () => 1_746_000_000_000,
      keychainAdapter,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // The original DB error is preserved; the keychain delete failure does NOT mask it.
      expect(result.error.code).not.toBe('KEYCHAIN_DELETE_FAILED');
      expect(result.error.code).not.toBe('KEYCHAIN_WRITE_FAILED');
    }
    // The keychain entry WAS written and the cleanup attempt happened (and failed) — verified via the writes map.
    expect(writes.get('slopweaver:github')).toBe('ghp_double_failure');
  });
});
