/**
 * Integration tests for the createDb() helper.
 *
 * Each test opens a fresh SQLite (in-memory or under a tmp directory),
 * applies migrations, exercises the schema, and closes the handle. The
 * cases pin the invariants the rest of the codebase relies on:
 * - the basic round-trip required by the issue acceptance criteria,
 * - the UNIQUE `(integration, external_id)` constraint on evidence_log
 *   (idempotent upserts in polling),
 * - the file-backed branch of createDb() actually creates the parent
 *   directory,
 * - `foreign_keys = ON` is applied,
 * - the workspaces single-row CHECK constraint rejects `id != 1`.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from './index.js';
import { evidenceLog, workspaces } from './schema/index.js';

describe('createDb', () => {
  it('runs migrations and can insert/read an evidence_log row', () => {
    const handle = createDb({ path: ':memory:' });

    try {
      const now = 1_746_234_567_890;
      const occurredAtMs = 1_746_230_000_000;

      handle.db
        .insert(evidenceLog)
        .values({
          integration: 'github',
          externalId: 'pr_123',
          kind: 'pull_request',
          citationUrl: 'https://github.com/slopweaver/slopweaver/pull/123',
          title: 'Scaffold db package',
          body: 'Initial scaffold',
          payloadJson: '{"id":123}',
          occurredAtMs,
          firstSeenAtMs: now,
          lastSeenAtMs: now,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .run();

      const row = handle.db.select().from(evidenceLog).get();

      expect(row).toMatchObject({
        integration: 'github',
        externalId: 'pr_123',
        kind: 'pull_request',
        citationUrl: 'https://github.com/slopweaver/slopweaver/pull/123',
        title: 'Scaffold db package',
        body: 'Initial scaffold',
        payloadJson: '{"id":123}',
        occurredAtMs,
        firstSeenAtMs: now,
        lastSeenAtMs: now,
        createdAtMs: now,
        updatedAtMs: now,
      });
    } finally {
      handle.close();
    }
  });

  it('enforces evidence_log uniqueness on integration + external_id', () => {
    const handle = createDb({ path: ':memory:' });

    try {
      const now = 1_746_234_567_890;
      const occurredAtMs = 1_746_230_000_000;

      handle.db
        .insert(evidenceLog)
        .values({
          integration: 'github',
          externalId: 'pr_123',
          kind: 'pull_request',
          citationUrl: null,
          title: 'Scaffold db package',
          body: 'Initial scaffold',
          payloadJson: '{"id":123}',
          occurredAtMs,
          firstSeenAtMs: now,
          lastSeenAtMs: now,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .run();

      expect(() => {
        handle.db
          .insert(evidenceLog)
          .values({
            integration: 'github',
            externalId: 'pr_123',
            kind: 'pull_request',
            citationUrl: null,
            title: 'Updated title',
            body: 'Updated body',
            payloadJson: '{"id":123,"updated":true}',
            occurredAtMs: occurredAtMs + 1,
            firstSeenAtMs: now,
            lastSeenAtMs: now + 1,
            createdAtMs: now,
            updatedAtMs: now + 1,
          })
          .run();
      }).toThrowError(/UNIQUE constraint failed/);

      expect(handle.db.select().from(evidenceLog).all()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('enables foreign_keys pragma on the connection', () => {
    const handle = createDb({ path: ':memory:' });

    try {
      const result = handle.sqlite.pragma('foreign_keys', { simple: true });
      expect(result).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('rejects workspaces rows with id != 1 via the single-row CHECK constraint', () => {
    const handle = createDb({ path: ':memory:' });

    try {
      const now = 1_746_234_567_890;

      handle.db
        .insert(workspaces)
        .values({ id: 1, name: 'default', createdAtMs: now, updatedAtMs: now })
        .run();

      expect(() => {
        handle.db
          .insert(workspaces)
          .values({ id: 2, name: 'other', createdAtMs: now, updatedAtMs: now })
          .run();
      }).toThrowError(/CHECK constraint failed/);

      expect(handle.db.select().from(workspaces).all()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  describe('with a file-backed path', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'slopweaver-db-test-'));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("creates the parent directory if it doesn't exist", () => {
      const dbPath = join(tmpRoot, 'nested', 'subdir', 'slopweaver.db');
      expect(existsSync(dirname(dbPath))).toBe(false);

      const handle = createDb({ path: dbPath });

      try {
        expect(existsSync(dirname(dbPath))).toBe(true);
        expect(existsSync(dbPath)).toBe(true);

        // Sanity-check migrations actually ran on disk.
        const tables = handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>;
        expect(tables.map((t) => t.name)).toEqual(
          expect.arrayContaining([
            'evidence_log',
            'identity_graph',
            'integration_state',
            'workspaces',
          ]),
        );
      } finally {
        handle.close();
      }
    });
  });
});
