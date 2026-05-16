/**
 * cli-tools lib-level error union.
 *
 * Currently scoped to `DataPathInvalidError` for the XDG validation in
 * `data-dir.ts`. Defined locally (rather than imported from
 * `@slopweaver/db`) so cli-tools has no runtime dependency on the SQLite
 * stack — same reasoning as the duplicated `resolveDataDir` helper.
 *
 * The shape and `code: 'DATA_PATH_INVALID'` discriminant match the
 * `DataPathInvalidError` exported by `@slopweaver/db`, so a caller that
 * mixes the two surfaces (e.g. `apps/mcp-local`) can exhaustively match on
 * one union.
 */

import type { BaseError } from '@slopweaver/errors';

export interface DataPathInvalidError extends BaseError {
  readonly code: 'DATA_PATH_INVALID';
  readonly xdgDataHome: string;
}

export const LibErrors = {
  dataPathInvalid: (xdgDataHome: string): DataPathInvalidError => ({
    code: 'DATA_PATH_INVALID',
    message: `XDG_DATA_HOME must be an absolute path; got: "${xdgDataHome}"`,
    xdgDataHome,
  }),
} as const;
