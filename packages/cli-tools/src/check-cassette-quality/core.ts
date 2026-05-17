/**
 * Pure logic for `check-cassette-quality`.
 *
 * Scans committed Polly HAR cassettes for auth/recording-failure signals
 * that indicate the cassette was recorded with an expired token or against
 * an unauthenticated session. Catches the most common cassette regression
 * before commit: re-recording with `POLLY_MODE=record` after the OAuth
 * token has rotated, ending up with a fixture full of `401` /
 * `invalid_grant` / `token expired` responses pretending to be the happy
 * path.
 *
 * Allowlist: paths that explicitly exercise error / refresh / unauth
 * scenarios are exempt (look at `ALLOWED_RECORDING_PATH_KEYWORDS`).
 *
 * Sliced from slopweaver-archive's `check-no-test-enshitification`
 * (specifically `scanRecordingHar` and friends). HAR-only — the other
 * sub-checks of that scanner (stub detection, E2E patterns) are owned
 * by Biome `noFocusedTests`/`noSkippedTests` + Oxlint, or don't apply.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const CASSETTE_ROOTS: ReadonlyArray<string> = [
  'packages/integrations/github',
  'packages/integrations/slack',
];

const POLLY_SUSPICIOUS_DIAGNOSTIC_PATTERNS: ReadonlyArray<string> = [
  'unauthorized',
  'unauthenticated',
  'invalid_grant',
  'invalid grant',
  'invalid_token',
  'invalid token',
  'invalid_client',
  'request had invalid authentication credentials',
  'authentication required',
  'unsupported_grant_type',
  'token expired',
  'expired token',
  'expired_token',
  'access token expired',
  'refresh token expired',
  'refresh token revoked',
  'token_expired',
  'authentication failed',
  'not authenticated',
  'access denied',
  'insufficient_scope',
  'invalidauthenticationtoken',
  'interactionrequiredautherror',
  'jwt is not well formed',
  'you need to authenticate',
];

const POLLY_RAW_TEXT_PATTERNS: ReadonlyArray<string> = [
  '[polly] [adapter:node-http] recording for the following request is not found',
];

const POLLY_DIAGNOSTIC_FIELD_NAMES: ReadonlySet<string> = new Set([
  'code',
  'detail',
  'details',
  'error',
  'error_code',
  'error_description',
  'error_summary',
  'errorcode',
  'errors',
  'message',
  'messages',
  'reason',
  'status',
  'statustext',
  'title',
]);

const ALLOWED_RECORDING_PATH_KEYWORDS: ReadonlyArray<string> = [
  'archive',
  'auth',
  'authorize',
  'error',
  'expired',
  'forbidden',
  'invalid',
  'missing',
  'no-integration',
  'not-found',
  'oauth',
  'rate-limit',
  'refresh',
  'reject',
  'revoked',
  'unauthor',
];

export function isAllowedRecordingPath({ relPath }: { relPath: string }): boolean {
  const lowered = relPath.toLowerCase();
  return ALLOWED_RECORDING_PATH_KEYWORDS.some((kw) => lowered.includes(kw));
}

function getHarResponseText({ entry }: { entry: Record<string, unknown> }): string {
  const response = (entry['response'] as Record<string, unknown> | undefined) ?? {};
  const content = (response['content'] as Record<string, unknown> | undefined) ?? {};
  const text = content['text'];
  return typeof text === 'string' ? text : '';
}

function getHarStatus({ entry }: { entry: Record<string, unknown> }): number | null {
  const response = (entry['response'] as Record<string, unknown> | undefined) ?? {};
  const status = response['status'];
  return typeof status === 'number' ? status : null;
}

function getHarRequestUrl({ entry }: { entry: Record<string, unknown> }): string {
  const request = (entry['request'] as Record<string, unknown> | undefined) ?? {};
  const url = request['url'];
  return typeof url === 'string' ? url : '';
}

/**
 * Recursively collect diagnostic string values from a parsed JSON structure.
 * Only collects values from fields whose names are in
 * POLLY_DIAGNOSTIC_FIELD_NAMES — so a free-text customer-data field
 * containing the word "error" doesn't false-positive.
 */
export function collectPollyDiagnosticStrings({ value }: { value: unknown }): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPollyDiagnosticStrings({ value: item }));
  }
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const diagnostics: string[] = [];
  for (const [key, nestedValue] of Object.entries(record)) {
    if (!POLLY_DIAGNOSTIC_FIELD_NAMES.has(key.toLowerCase())) continue;
    diagnostics.push(...collectPollyDiagnosticStrings({ value: nestedValue }));
  }
  return diagnostics;
}

function getPollyDiagnosticText({ bodyText }: { bodyText: string }): string {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return collectPollyDiagnosticStrings({ value: parsed }).join('\n').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Scan a parsed HAR recording for auth/recording-failure signals.
 *
 * @param content - The parsed HAR JSON object
 * @param relPath - Workspace-relative path (used for allowlist + reporting)
 */
export function scanRecordingHar({
  content,
  relPath,
}: {
  content: Record<string, unknown>;
  relPath: string;
}): Violation[] {
  const violations: Violation[] = [];

  const log = (content['log'] as Record<string, unknown> | undefined) ?? {};
  const entries = Array.isArray(log['entries'])
    ? (log['entries'] as Array<Record<string, unknown>>)
    : [];
  if (entries.length === 0) return violations;

  const allowAuthFailures = isAllowedRecordingPath({ relPath });

  for (const entry of entries) {
    const bodyText = getHarResponseText({ entry });
    const loweredBody = bodyText.toLowerCase();
    const diagnosticText = getPollyDiagnosticText({ bodyText });
    const status = getHarStatus({ entry });
    const url = getHarRequestUrl({ entry });

    const looksLikeShortPlainErrorBody =
      diagnosticText.length === 0 && bodyText.trim().length > 0 && bodyText.length < 2_000;
    const containsSuspiciousText =
      POLLY_RAW_TEXT_PATTERNS.some((pattern) => loweredBody.includes(pattern)) ||
      POLLY_SUSPICIOUS_DIAGNOSTIC_PATTERNS.some(
        (pattern) =>
          diagnosticText.includes(pattern) ||
          (looksLikeShortPlainErrorBody && loweredBody.includes(pattern)),
      );
    const isSuspiciousStatus = status === 401 || status === 403;

    if (allowAuthFailures || (!containsSuspiciousText && !isSuspiciousStatus)) continue;

    const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 220);
    violations.push({
      file: relPath,
      line: 1,
      text: `status=${status ?? 'unknown'} url=${url} snippet=${snippet}`,
    });
  }

  return violations;
}

/**
 * List every committed `*.har` cassette under the configured integration
 * roots. Returns workspace-relative paths.
 */
export function listCassetteFiles({ root }: { root: string }): string[] {
  const out: string[] = [];
  for (const cassetteRoot of CASSETTE_ROOTS) {
    const abs = join(root, cassetteRoot);
    if (!existsSync(abs)) continue;
    walk({ abs, rel: cassetteRoot, out });
  }
  return out;
}

function walk({ abs, rel, out }: { abs: string; rel: string; out: string[] }): void {
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
    const childAbs = join(abs, entry);
    const childRel = `${rel}/${entry}`;
    const stat = statSync(childAbs);
    if (stat.isDirectory()) {
      walk({ abs: childAbs, rel: childRel, out });
      continue;
    }
    if (!stat.isFile()) continue;
    if (!entry.endsWith('.har')) continue;
    out.push(childRel);
  }
}

/**
 * Read each cassette file, parse the JSON, and aggregate any
 * auth/recording-failure violations. A non-parseable cassette is itself a
 * violation — a HAR that's been corrupted is just as bad as one full of
 * 401s.
 */
export function scanFiles({
  root,
  paths,
}: {
  root: string;
  paths: ReadonlyArray<string>;
}): Violation[] {
  const out: Violation[] = [];
  for (const file of paths) {
    const raw = readFileSync(join(root, file), 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      out.push({ file, line: 1, text: 'cassette is not valid JSON' });
      continue;
    }
    out.push(...scanRecordingHar({ content: parsed, relPath: file }));
  }
  return out;
}
