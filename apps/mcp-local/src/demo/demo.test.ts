/**
 * Unit tests for the `slopweaver demo` family of subcommands.
 *
 * Pure-function tests against the helpers in `./index.ts`. The demo DB
 * is opened against an `XDG_DATA_HOME`-style tmpdir so we never touch
 * the developer's real `~/.slopweaver/demo.db`. Smoke coverage of the
 * end-to-end CLI flow (binary spawn + `start_session` returning >0
 * rows against the seeded demo DB) lives in `../cli.smoke.test.ts`.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, evidenceLog, integrationState } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropDemoDbFile, isDemoDb, runDemo, runDemoExit, runDemoReset, runDemoSeed, seedDemoDb } from './index.ts';
import { DEMO_EVIDENCE, DEMO_SENTINEL_INTEGRATION, DEMO_SNAPSHOT } from './synthetic-persona.ts';

describe('runDemo', () => {
  it('writes the synthetic snapshot to stdout and returns 0', async () => {
    const stdout = { write: vi.fn() };
    const code = await runDemo({ stdout });
    expect(code).toBe(0);
    expect(stdout.write).toHaveBeenCalledOnce();
    expect(stdout.write.mock.calls[0]?.[0]).toBe(DEMO_SNAPSHOT);
  });
});

describe('DEMO_SNAPSHOT', () => {
  it('does not contain personal identifiers', () => {
    // The synthetic persona is generic. Any real name / employer / channel
    // would be a leak — fail the build if one ever sneaks in.
    expect(DEMO_SNAPSHOT).not.toMatch(/Lachie|Everlab|@everlab/i);
  });

  it('ends with the canonical session-start closer', () => {
    expect(DEMO_SNAPSHOT).toContain('What are we working on this session?');
  });

  it('mentions the BYOK try-it-yourself path', () => {
    expect(DEMO_SNAPSHOT).toContain('claude mcp add slopweaver');
  });

  it('points the reader at the real MCP entry point (start_session tool) — no fictional slash commands', () => {
    // PR #78 review P2: an earlier draft told users to run `/session-start`,
    // but this repo ships start_session as an MCP tool, not a slash command.
    // The snapshot must not advertise a non-existent surface.
    expect(DEMO_SNAPSHOT).not.toMatch(/\/session-start/);
    expect(DEMO_SNAPSHOT).toContain('start_session');
  });

  it('only claims integrations that actually ship today (GitHub + Slack)', () => {
    // PR #78 review P2: an earlier draft listed Slack / GitHub / Linear /
    // Gmail / Calendar as "polled this run", but v1.0 only ships GitHub +
    // Slack. The "Sources polled this run" header must reflect that.
    const polledLine = DEMO_SNAPSHOT.match(/Sources polled this run:[^\n]+/);
    expect(polledLine).not.toBeNull();
    if (polledLine !== null) {
      const line = polledLine[0];
      expect(line).toContain('Slack');
      expect(line).toContain('GitHub');
      // Linear / Gmail / Calendar may still appear in the persona text
      // *labelled as planned*, but never inside the "polled this run"
      // checkmark line.
      expect(line).not.toContain('Linear');
      expect(line).not.toContain('Gmail');
      expect(line).not.toContain('Calendar');
    }
  });
});

describe('DEMO_EVIDENCE', () => {
  it('seeds at least 10 rows per shipped integration so start_session has signal to rank', () => {
    const githubRows = DEMO_EVIDENCE.filter((r) => r.integration === 'github');
    const slackRows = DEMO_EVIDENCE.filter((r) => r.integration === 'slack');
    // PR #78 review P1 spec: "10-20 rows per integration covered by current build".
    expect(githubRows.length).toBeGreaterThanOrEqual(10);
    expect(slackRows.length).toBeGreaterThanOrEqual(10);
    expect(githubRows.length).toBeLessThanOrEqual(20);
    expect(slackRows.length).toBeLessThanOrEqual(20);
  });

  it('only seeds rows for integrations that ship today (no Linear / Gmail / Calendar)', () => {
    for (const row of DEMO_EVIDENCE) {
      expect(['github', 'slack']).toContain(row.integration);
    }
  });

  it('every row carries a unique external_id within its integration', () => {
    const seen = new Set<string>();
    for (const row of DEMO_EVIDENCE) {
      const key = `${row.integration}:${row.externalId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('seedDemoDb / runDemoSeed', () => {
  let tmp: string;
  let demoDbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'slopweaver-demo-'));
    demoDbPath = resolve(tmp, 'demo.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the demo DB file and seeds every DEMO_EVIDENCE row', async () => {
    const result = await seedDemoDb({ demoDbPath, now: 1_700_000_000_000 });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.evidenceRowsSeeded).toBe(DEMO_EVIDENCE.length);
      expect(result.value.sentinelWritten).toBe(true);
    }
    expect(existsSync(demoDbPath)).toBe(true);

    // Inspect the DB independently to prove the seeded rows are queryable.
    const handle = createDb({ path: demoDbPath });
    try {
      const rows = handle.db.select().from(evidenceLog).all();
      expect(rows.length).toBe(DEMO_EVIDENCE.length);
      // Both integrations are represented.
      const githubCount = rows.filter((r) => r.integration === 'github').length;
      const slackCount = rows.filter((r) => r.integration === 'slack').length;
      expect(githubCount).toBeGreaterThan(0);
      expect(slackCount).toBeGreaterThan(0);

      // Sentinel row is present.
      expect(isDemoDb({ db: handle.db })).toBe(true);
      const sentinel = handle.db
        .select()
        .from(integrationState)
        .all()
        .find((r) => r.integration === DEMO_SENTINEL_INTEGRATION);
      expect(sentinel).toBeDefined();
    } finally {
      handle.close();
    }
  });

  it('is idempotent — re-seeding does not duplicate rows', async () => {
    const first = await seedDemoDb({ demoDbPath, now: 1_700_000_000_000 });
    expect(first.isOk()).toBe(true);
    const second = await seedDemoDb({ demoDbPath, now: 1_700_000_100_000 });
    expect(second.isOk()).toBe(true);

    const handle = createDb({ path: demoDbPath });
    try {
      const rows = handle.db.select().from(evidenceLog).all();
      expect(rows.length).toBe(DEMO_EVIDENCE.length);
    } finally {
      handle.close();
    }
  });

  it('runDemoSeed exits 0 and prints the seeded path to stdout', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runDemoSeed({ demoDbPath, stdout, stderr, now: () => 1_700_000_000_000 });
    expect(code).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    const combined = stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain(demoDbPath);
    expect(combined).toContain('SLOPWEAVER_DEMO=1');
  });
});

describe('runDemoReset', () => {
  let tmp: string;
  let demoDbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'slopweaver-demo-reset-'));
    demoDbPath = resolve(tmp, 'demo.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drops an existing demo DB and re-seeds it', async () => {
    // Seed first.
    const seed = await seedDemoDb({ demoDbPath, now: 1_700_000_000_000 });
    expect(seed.isOk()).toBe(true);

    // Reset.
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runDemoReset({ demoDbPath, stdout, stderr, now: () => 1_700_000_500_000 });
    expect(code).toBe(0);
    expect(existsSync(demoDbPath)).toBe(true);

    const combined = stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('removed existing demo DB');
  });

  it('is a no-op-then-seed when the demo DB does not exist', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runDemoReset({ demoDbPath, stdout, stderr, now: () => 1_700_000_500_000 });
    expect(code).toBe(0);
    expect(existsSync(demoDbPath)).toBe(true);
    const combined = stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(combined).not.toContain('removed existing demo DB');
  });
});

describe('runDemoExit / dropDemoDbFile', () => {
  let tmp: string;
  let demoDbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'slopweaver-demo-exit-'));
    demoDbPath = resolve(tmp, 'demo.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('removes a seeded demo DB', async () => {
    await seedDemoDb({ demoDbPath, now: 1_700_000_000_000 });
    expect(existsSync(demoDbPath)).toBe(true);

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runDemoExit({ demoDbPath, stdout, stderr });
    expect(code).toBe(0);
    expect(existsSync(demoDbPath)).toBe(false);
  });

  it('succeeds silently when no demo DB is present', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runDemoExit({ demoDbPath, stdout, stderr });
    expect(code).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    const combined = stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('no demo DB present');
  });

  it('dropDemoDbFile returns removed:false when nothing exists', async () => {
    const result = await dropDemoDbFile({ demoDbPath });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.removed).toBe(false);
    }
  });
});
