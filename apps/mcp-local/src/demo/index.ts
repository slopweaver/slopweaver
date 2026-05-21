/**
 * `slopweaver demo` — try-before-BYOK demo mode.
 *
 * Three subcommands plus a bare default:
 *
 * - `slopweaver demo` — print the {@link DEMO_SNAPSHOT} synthetic
 *   `start_session` markdown to stdout. Zero side effects; pure
 *   read-only screenshot.
 *
 * - `slopweaver demo seed` — open a dedicated demo SQLite DB (under
 *   `<dataDir>/demo.db`, separate from `slopweaver.db`), seed it with
 *   {@link DEMO_EVIDENCE} synthetic rows, and stamp an
 *   `integration_state` sentinel row so callers can detect demo mode.
 *
 * - `slopweaver demo reset` — drop the demo DB and re-seed it. Useful
 *   when the synthetic data has drifted (e.g. timestamps now look
 *   ancient) or after a schema bump.
 *
 * - `slopweaver demo exit` — delete the demo DB. Future `slopweaver`
 *   invocations without `--demo` already use the real
 *   `slopweaver.db`; this just cleans up the demo file so disk usage
 *   isn't left behind.
 *
 * The MCP server (`runMcpServer` in `cli.ts`) accepts a `--demo` flag
 * (or `SLOPWEAVER_DEMO=1`) to point its DB resolver at `demo.db`
 * instead of `slopweaver.db`. Once that flag is set, the *real*
 * `start_session` tool serves the synthetic rows seeded here — the
 * demo isn't a separate code path, it's the same product running
 * against a separate database file.
 *
 * Note: this module manipulates SQLite directly and so follows the
 * service-boundary rule (no throws). All failure modes funnel through
 * the typed Result returned by the helpers below, which the CLI
 * boundary unwraps in `cli.ts`.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { createDb, integrationState, safeQuery, type SlopweaverDatabase } from '@slopweaver/db';
import type { BaseError, DatabaseError } from '@slopweaver/errors';
import { okAsync, ResultAsync } from '@slopweaver/errors';
import { upsertEvidence } from '@slopweaver/integrations-core';
import { eq } from 'drizzle-orm';
import { DEMO_EVIDENCE, DEMO_SENTINEL_INTEGRATION, DEMO_SNAPSHOT } from './synthetic-persona.ts';

export interface DemoOperationFailedError extends BaseError {
  readonly code: 'DEMO_OPERATION_FAILED';
}

const DemoErrors = {
  operationFailed: (message: string): DemoOperationFailedError => ({
    code: 'DEMO_OPERATION_FAILED',
    message,
  }),
} as const;

export type DemoError = DemoOperationFailedError | DatabaseError;

export type RunDemoDeps = {
  stdout: { write: (s: string) => void };
};

/**
 * Print the synthetic `start_session` snapshot to stdout. Pure read-only
 * — no DB, no network. Returns 0 unconditionally (the CLI boundary
 * translates that to `process.exit(0)`).
 */
export async function runDemo(deps: RunDemoDeps): Promise<number> {
  deps.stdout.write(DEMO_SNAPSHOT);
  return 0;
}

export type DemoSeedDeps = {
  /**
   * Absolute path to the demo SQLite file. Resolve via `resolveDemoDbPath()`
   * at the CLI boundary so XDG validation happens once.
   */
  demoDbPath: string;
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Seed the demo DB with {@link DEMO_EVIDENCE} synthetic rows plus a
 * sentinel `integration_state` row identifying the DB as demo state.
 *
 * Idempotent: existing rows with matching `(integration, external_id)`
 * are updated in place via `upsertEvidence`'s conflict-on-update path,
 * so re-running `demo seed` against an already-seeded DB refreshes the
 * timestamps without duplicating rows. The sentinel row is upserted on
 * each call.
 */
export async function runDemoSeed(deps: DemoSeedDeps): Promise<number> {
  const result = await seedDemoDb({ demoDbPath: deps.demoDbPath, now: (deps.now ?? Date.now)() });
  if (result.isErr()) {
    deps.stderr.write(`slopweaver: demo seed failed: ${result.error.message}\n`);
    return 1;
  }
  deps.stdout.write(
    `slopweaver: seeded ${String(result.value.evidenceRowsSeeded)} synthetic evidence rows into ${deps.demoDbPath}\n`,
  );
  deps.stdout.write('slopweaver: enable demo mode by passing --demo or setting SLOPWEAVER_DEMO=1 on the MCP server.\n');
  return 0;
}

export type DemoResetDeps = DemoSeedDeps;

/**
 * Drop the demo DB file (if any) and seed a fresh one. The drop is
 * file-level rather than `DROP TABLE` so the demo schema always
 * matches the current Drizzle migrations — no manual migration
 * gymnastics required.
 */
export async function runDemoReset(deps: DemoResetDeps): Promise<number> {
  const dropResult = await dropDemoDbFile({ demoDbPath: deps.demoDbPath });
  if (dropResult.isErr()) {
    deps.stderr.write(`slopweaver: demo reset failed: ${dropResult.error.message}\n`);
    return 1;
  }
  if (dropResult.value.removed) {
    deps.stdout.write(`slopweaver: removed existing demo DB at ${deps.demoDbPath}\n`);
  }
  return runDemoSeed(deps);
}

export type DemoExitDeps = {
  demoDbPath: string;
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

/**
 * Remove the demo DB file. The real DB (`slopweaver.db`) is untouched
 * — future `slopweaver` invocations without `--demo` already use it.
 * Idempotent: succeeds silently if the demo DB doesn't exist.
 */
export async function runDemoExit(deps: DemoExitDeps): Promise<number> {
  const dropResult = await dropDemoDbFile({ demoDbPath: deps.demoDbPath });
  if (dropResult.isErr()) {
    deps.stderr.write(`slopweaver: demo exit failed: ${dropResult.error.message}\n`);
    return 1;
  }
  if (dropResult.value.removed) {
    deps.stdout.write(`slopweaver: demo DB removed (${deps.demoDbPath}).\n`);
  } else {
    deps.stdout.write('slopweaver: no demo DB present; nothing to remove.\n');
  }
  deps.stdout.write('slopweaver: start the server without --demo to use your real DB.\n');
  return 0;
}

/**
 * Result of {@link seedDemoDb}: how many evidence rows were upserted
 * and whether the sentinel row was newly created.
 */
interface DemoSeedSummary {
  readonly evidenceRowsSeeded: number;
  readonly sentinelWritten: boolean;
}

/**
 * Core seed logic — open the demo DB, upsert every {@link DEMO_EVIDENCE}
 * row, stamp the sentinel `integration_state` row, close the handle.
 * Exported for tests; the CLI calls it via {@link runDemoSeed}.
 */
export function seedDemoDb({
  demoDbPath,
  now,
}: {
  demoDbPath: string;
  now: number;
}): ResultAsync<DemoSeedSummary, DemoError> {
  return openDemoDb({ demoDbPath }).andThen((handle) =>
    seedEvidenceRows({ db: handle.db, now })
      .andThen((evidenceRowsSeeded) =>
        // Stamp `integration_state` for each integration we just seeded.
        // Without this, `start_session` would think the demo DB has
        // "never polled" any integration, treat all the cached evidence
        // as stale, and refuse to surface it (the no-poller branch
        // skips refresh but the integration is still listed in
        // freshness as stale). Writing a completed-poll marker per
        // integration mirrors what a real poll cycle would do.
        seedIntegrationStateForDemo({ db: handle.db, now }).andThen(() =>
          upsertSentinelState({ db: handle.db, now }).map(() => ({
            evidenceRowsSeeded,
            sentinelWritten: true,
          })),
        ),
      )
      .map((summary) => {
        // Close on success; the file lock is released so a subsequent
        // `start_session --demo` invocation can open the same file.
        handle.close();
        return summary;
      })
      .mapErr((error) => {
        // Close on failure too. The caller is free to retry or inspect
        // the partially-seeded file; leaving the file lock held would
        // block both.
        handle.close();
        return error;
      }),
  );
}

interface DemoSeedHandle {
  readonly db: SlopweaverDatabase;
  readonly close: () => void;
}

/**
 * Open the demo DB. `createDb` runs Drizzle migrations and may throw
 * (parent-dir creation, sqlite native init) — lift those into a Result
 * so callers don't need a separate try/catch.
 */
function openDemoDb({ demoDbPath }: { demoDbPath: string }): ResultAsync<DemoSeedHandle, DemoOperationFailedError> {
  return ResultAsync.fromPromise(
    // `createDb` is synchronous; wrap in Promise.resolve so any
    // synchronous throw lands in the rejection branch. Without this
    // wrapper a throw would propagate out of `fromPromise` itself.
    Promise.resolve().then(() => {
      const handle = createDb({ path: demoDbPath });
      return { db: handle.db, close: handle.close };
    }),
    (error): DemoOperationFailedError =>
      DemoErrors.operationFailed(
        `failed to open demo DB at ${demoDbPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );
}

/**
 * Iteratively upsert every {@link DEMO_EVIDENCE} row. Returns the
 * count of rows seeded on success; short-circuits to the underlying
 * `DatabaseError` if any row fails.
 */
function seedEvidenceRows({ db, now }: { db: SlopweaverDatabase; now: number }): ResultAsync<number, DatabaseError> {
  const step = (index: number, count: number): ResultAsync<number, DatabaseError> => {
    if (index >= DEMO_EVIDENCE.length) return okAsync(count);
    const row = DEMO_EVIDENCE[index];
    if (row === undefined) return okAsync(count);
    const occurredAtMs = now + row.occurredAtOffsetMs;
    return upsertEvidence({
      db,
      integration: row.integration,
      externalId: row.externalId,
      kind: row.kind,
      title: row.title,
      body: row.body,
      citationUrl: row.citationUrl,
      payloadJson: row.payloadJson,
      occurredAtMs,
      now,
    }).andThen(() => step(index + 1, count + 1));
  };
  return step(0, 0);
}

/**
 * Stamp an `integration_state` row for each integration represented
 * in {@link DEMO_EVIDENCE} so `start_session` considers them
 * "recently polled" instead of "never polled". Without this, the
 * default `start_session` path would have `requested = []` (no
 * pollers, no state rows for the shipped integrations) and return an
 * empty response despite the evidence rows being present.
 */
function seedIntegrationStateForDemo({
  db,
  now,
}: {
  db: SlopweaverDatabase;
  now: number;
}): ResultAsync<void, DatabaseError> {
  const integrations = Array.from(new Set(DEMO_EVIDENCE.map((row) => row.integration)));
  return safeQuery({
    execute: () => {
      for (const integration of integrations) {
        const existing = db
          .select({ integration: integrationState.integration })
          .from(integrationState)
          .where(eq(integrationState.integration, integration))
          .get();
        if (existing === undefined) {
          db.insert(integrationState)
            .values({
              integration,
              cursor: 'demo',
              lastPollStartedAtMs: now,
              lastPollCompletedAtMs: now,
              createdAtMs: now,
              updatedAtMs: now,
            })
            .run();
        } else {
          db.update(integrationState)
            .set({
              lastPollStartedAtMs: now,
              lastPollCompletedAtMs: now,
              updatedAtMs: now,
            })
            .where(eq(integrationState.integration, integration))
            .run();
        }
      }
    },
  });
}

/**
 * Insert (or refresh) the sentinel row that marks this DB as demo
 * state. Service code never reads this row to make decisions — it's
 * purely a label for the Diagnostics UI / future `doctor` command.
 */
function upsertSentinelState({ db, now }: { db: SlopweaverDatabase; now: number }): ResultAsync<void, DatabaseError> {
  return safeQuery({
    execute: () => {
      const existing = db
        .select({ integration: integrationState.integration })
        .from(integrationState)
        .where(eq(integrationState.integration, DEMO_SENTINEL_INTEGRATION))
        .get();
      if (existing === undefined) {
        db.insert(integrationState)
          .values({
            integration: DEMO_SENTINEL_INTEGRATION,
            cursor: 'demo',
            lastPollStartedAtMs: now,
            lastPollCompletedAtMs: now,
            createdAtMs: now,
            updatedAtMs: now,
          })
          .run();
      } else {
        db.update(integrationState)
          .set({
            lastPollStartedAtMs: now,
            lastPollCompletedAtMs: now,
            updatedAtMs: now,
          })
          .where(eq(integrationState.integration, DEMO_SENTINEL_INTEGRATION))
          .run();
      }
    },
  });
}

/**
 * Remove the demo DB file. Returns `{ removed: true }` if the file
 * existed and was deleted, `{ removed: false }` if nothing was there.
 * The Result wraps an `unlinkSync` failure (e.g. permission denied)
 * into a `DEMO_OPERATION_FAILED` error so the CLI boundary can print
 * a clean message.
 */
export function dropDemoDbFile({
  demoDbPath,
}: {
  demoDbPath: string;
}): ResultAsync<{ removed: boolean }, DemoOperationFailedError> {
  if (!existsSync(demoDbPath)) return okAsync({ removed: false });
  return safeQuery({
    execute: () => {
      unlinkSync(demoDbPath);
      return { removed: true };
    },
  }).mapErr((error) => DemoErrors.operationFailed(`failed to remove demo DB at ${demoDbPath}: ${error.message}`));
}

/**
 * Check whether the supplied DB is currently in demo mode (i.e. has
 * the {@link DEMO_SENTINEL_INTEGRATION} row in `integration_state`).
 * Exposed so the Diagnostics UI / future `doctor` command can label
 * demo profiles without re-deriving the file path.
 */
export function isDemoDb({ db }: { db: SlopweaverDatabase }): boolean {
  const row = db
    .select({ integration: integrationState.integration })
    .from(integrationState)
    .where(eq(integrationState.integration, DEMO_SENTINEL_INTEGRATION))
    .get();
  return row !== undefined;
}
