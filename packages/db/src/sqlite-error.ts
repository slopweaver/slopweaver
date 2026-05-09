/**
 * better-sqlite3 error-shape extractor.
 *
 * better-sqlite3 throws errors (often `SqliteError`) with a `.code` field
 * like `"SQLITE_CONSTRAINT_UNIQUE"`, `"SQLITE_BUSY"`, or
 * `"SQLITE_CONSTRAINT_FOREIGNKEY"` and a human-readable `.message`.
 * Drizzle ORM may catch and re-throw, attaching the raw sqlite error
 * via `.cause` — so the extractor walks the `.cause` chain looking for
 * the most specific shape.
 *
 * Mirrors `extractDatabaseErrorShape` in `slopweaver-private`'s
 * postgres-error.utils, scoped to the SQLite error vocabulary. There's
 * no separate `constraint` / `table` field on a SqliteError (that
 * info is embedded in the message), so the parser pulls them out
 * heuristically when the message has the standard
 * `"UNIQUE constraint failed: tablename.column"` shape.
 */

export interface SqliteErrorShape {
  message: string;
  code?: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

const SQLITE_ERROR_CODE_PATTERN = /^SQLITE_[A-Z_]+$/;
const CONSTRAINT_FAILED_PATTERN =
  /^(?:UNIQUE|FOREIGN KEY|CHECK|NOT NULL|PRIMARY KEY) constraint failed:\s*(?<rest>.+)$/u;

interface SqliteErrorLike {
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null;

const isSqliteCode = (code: string | undefined): code is string =>
  code !== undefined && SQLITE_ERROR_CODE_PATTERN.test(code);

/**
 * `"UNIQUE constraint failed: integration_tokens.integration"` →
 * `{ table: "integration_tokens", constraint: "integration" }`.
 *
 * Returns an empty object if the message doesn't match the expected
 * SQLite constraint-failed format.
 */
function parseConstraintMessage(message: string): { table?: string; constraint?: string } {
  const match = CONSTRAINT_FAILED_PATTERN.exec(message);
  const rest = match?.groups?.['rest']?.trim();
  if (!rest) return {};

  const [tableAndColumn] = rest.split(/[\s,]/);
  if (!tableAndColumn) return {};

  const [table, ...columnParts] = tableAndColumn.split('.');
  if (!table) return {};

  const constraint = columnParts.join('.');
  return constraint ? { table, constraint } : { table };
}

export function extractSqliteErrorShape({ error }: { error: unknown }): SqliteErrorShape | null {
  const queue: unknown[] = [error];
  const visited = new Set<unknown>();
  const candidates: SqliteErrorLike[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (!isObjectLike(current)) continue;
    const errorLike: SqliteErrorLike = current;

    const code = asOptionalString(errorLike.code);
    if (isSqliteCode(code) || asOptionalString(errorLike.message) !== undefined) {
      candidates.push(errorLike);
    }

    if (errorLike.cause !== undefined) {
      queue.push(errorLike.cause);
    }
  }

  if (candidates.length === 0) return null;

  // Prefer the most specific candidate (the one with a SQLITE_* code);
  // fall back to the first candidate (which carries at least a message).
  const candidateWithCode = candidates.find((c) => isSqliteCode(asOptionalString(c.code)));
  const selected = candidateWithCode ?? candidates[0];
  if (!selected) return null;

  const code = asOptionalString(selected.code);
  const rootMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Database operation failed';
  const message = asOptionalString(selected.message) ?? rootMessage;
  const { table, constraint } = parseConstraintMessage(message);

  const result: SqliteErrorShape = { message };
  if (isSqliteCode(code)) result.code = code;
  if (table) result.table = table;
  if (constraint) result.constraint = constraint;
  return result;
}
