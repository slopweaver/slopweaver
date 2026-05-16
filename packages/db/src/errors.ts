/**
 * @slopweaver/db domain-level error union.
 *
 * `DatabaseError` (raw output of `safeQuery`) lives in `@slopweaver/errors`
 * because non-db packages also include it in their unions. The errors here
 * cover failure modes that originate inside this package but aren't SQLite
 * runtime errors — currently just `DataPathInvalidError` for the XDG
 * validation in `path.ts`.
 */

import type { BaseError } from '@slopweaver/errors';

export interface DataPathInvalidError extends BaseError {
  readonly code: 'DATA_PATH_INVALID';
  readonly xdgDataHome: string;
}

export const DbErrors = {
  dataPathInvalid: (xdgDataHome: string): DataPathInvalidError => ({
    code: 'DATA_PATH_INVALID',
    message: `XDG_DATA_HOME must be an absolute path; got: "${xdgDataHome}"`,
    xdgDataHome,
  }),
} as const;
