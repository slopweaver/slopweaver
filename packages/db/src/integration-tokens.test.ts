/**
 * Unit tests for loadIntegrationToken / saveIntegrationToken.
 *
 * Pins the contracts the CLI subcommands and the future polling layer rely
 * on: missing rows surface as `null` (not Err), repeat saves upsert cleanly
 * without resetting `created_at_ms`, and writes are scoped per integration
 * slug. Result-based assertions per .claude/rules/error-handling.md.
 */

import { describe, expect, it } from 'vitest';
import { createDb } from './index.ts';
import { loadIntegrationToken, saveIntegrationToken } from './integration-tokens.ts';
import { integrationTokens } from './schema/integration-tokens.ts';

describe('loadIntegrationToken', () => {
  it('returns ok(null) when no row exists for the integration', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      const result = await loadIntegrationToken({ db: handle.db, integration: 'github' });
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
      const saveResult = await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_test_value',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
      });
      expect(saveResult.isOk()).toBe(true);

      const loadResult = await loadIntegrationToken({ db: handle.db, integration: 'github' });
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
      await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_github',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
      });

      const result = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    } finally {
      handle.close();
    }
  });
});

describe('saveIntegrationToken', () => {
  it('upserts: re-saving the same integration overwrites token + account label', async () => {
    const handle = createDb({ path: ':memory:' });
    try {
      await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_old',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
      });
      await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_new',
        accountLabel: 'octocat-renamed',
        now: () => 1_746_000_000_500,
      });

      const loaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
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
      await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_first',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_000,
      });
      await saveIntegrationToken({
        db: handle.db,
        integration: 'github',
        token: 'ghp_second',
        accountLabel: 'octocat',
        now: () => 1_746_000_000_999,
      });

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
      await saveIntegrationToken({
        db: handle.db,
        integration: 'slack',
        token: 'xoxb-redacted',
        accountLabel: null,
        now: () => 1_746_000_000_000,
      });

      const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
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
});
