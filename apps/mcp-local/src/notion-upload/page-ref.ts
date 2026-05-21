/**
 * Pure helpers for the Notion page-id / file-uuid extraction parts of
 * the upload flow. Separated from the HTTP layer so the unit suite
 * can pin the parsing without spinning up fetch stubs.
 */

import { err, ok, type Result } from '@slopweaver/errors';
import { NotionUploadErrors, type NotionInvalidPageRefError } from './errors.ts';

const HEX_CHAR = /[0-9a-f]/i;

/**
 * Accept a dashed UUID, undashed 32-hex string, or a notion.so URL.
 * Strip everything except hex characters, take the trailing 32, and
 * format as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
 */
export function normalisePageRef({ pageRef }: { pageRef: string }): Result<string, NotionInvalidPageRefError> {
  const lower = pageRef.trim().toLowerCase();
  let hex = '';
  for (const ch of lower) {
    if (HEX_CHAR.test(ch)) hex += ch;
  }
  if (hex.length < 32) {
    return err(NotionUploadErrors.invalidPageRef({ pageRef }));
  }
  const tail = hex.slice(-32);
  const dashed = `${tail.slice(0, 8)}-${tail.slice(8, 12)}-${tail.slice(12, 16)}-${tail.slice(16, 20)}-${tail.slice(20, 32)}`;
  return ok(dashed);
}

/**
 * Extract the file UUID embedded in an `attachment:<uuid>:<filename>`
 * URL. Returns `null` when the shape doesn't match — callers map that
 * to `NOTION_UPLOAD_URL_FAILED` since the upload-URL response from
 * Notion was malformed.
 */
export function extractFileUuid({ attachmentUrl }: { attachmentUrl: string }): string | null {
  // The shape is `attachment:<uuid>:<filename>`. The filename can
  // contain colons, so we only split off the first two segments.
  const parts = attachmentUrl.split(':');
  if (parts.length < 3 || parts[0] !== 'attachment') return null;
  const uuid = parts[1];
  if (uuid === undefined || uuid.length === 0) return null;
  return uuid;
}
