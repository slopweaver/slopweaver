/**
 * Integration tests for the createDb() helper.
 *
 * Each test opens a fresh `:memory:` SQLite, applies migrations, exercises
 * the schema, and closes the handle. The two cases pin (1) the basic
 * round-trip required by the issue acceptance criteria, and (2) the UNIQUE
 * `(integration, external_id)` constraint that the polling layer relies on
 * for idempotent upserts.
 */

import { describe, expect, it } from 'vitest';
import { createDb } from './index.ts';
import { evidenceLog } from './schema/index.ts';

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
});
