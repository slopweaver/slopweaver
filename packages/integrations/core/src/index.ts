/**
 * @slopweaver/integrations-core public entry.
 *
 * Re-exports the shared upsert helpers. The Polly cassette setup is exposed
 * via the dedicated `@slopweaver/integrations-core/test-setup/polly` subpath
 * (declared in `package.json` `exports`) so non-test consumers don't pull
 * the polly + nock + node-fetch dependency tree at runtime.
 */

export {
  markPollCompleted,
  markPollStarted,
  readCursor,
  upsertEvidence,
  type UpsertEvidenceArgs,
} from './upsert.ts';
