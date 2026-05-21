/**
 * Regression test for the mega-audit instructional body. Every tool
 * the prompt tells the model to call must be either (a) actually
 * registered in the server build that ships `start_mega_audit`, or
 * (b) explicitly marked optional with a concrete fallback path.
 *
 * If a future PR adds a new tool reference to the prompt without
 * either wiring it up or marking it optional, this test fails and the
 * reviewer is forced to make the dependency explicit.
 *
 * What "registered" means here: present in the tool list that the
 * production `slopweaver` CLI passes to `createMcpServer` (see
 * `apps/mcp-local/src/cli.ts`'s `runMcpServer`). This test maintains a
 * snapshot of that list locally rather than importing the CLI module
 * — the CLI module is the wiring layer and pulls in heavy deps; the
 * goal is to validate the prompt content, not exercise the wiring.
 */

import { describe, expect, it } from 'vitest';
import { MEGA_AUDIT_INSTRUCTIONS } from './instructions.ts';

/**
 * The tool names registered by `apps/mcp-local/src/cli.ts`'s
 * `runMcpServer` (see `createMcpServer({ tools: [...] })`). Keep in
 * sync if a new builtin is added.
 */
const REGISTERED_TOOLS: readonly string[] = [
  'ping',
  'start_session',
  'get_freshness',
  'catch_me_up',
  'search_work_context',
  'start_mega_audit',
  'record_audit_progress',
] as const;

/**
 * Tools the prompt references but knows aren't necessarily wired in
 * every server build. Each entry must appear in the prompt body with
 * a phrase that signals the dependency is optional (e.g. "if
 * available", "if wired up", "if registered", "if present"). The test
 * below enforces that signal.
 */
const OPTIONAL_TOOLS: readonly string[] = [
  'ensure_work_console_branch',
  'bootstrap_work_console',
  'list_available_mcp_servers',
  'apply_voice_rules',
] as const;

/**
 * Phrases that mark a tool reference as optional. The test checks
 * that within ~200 characters of an OPTIONAL_TOOLS mention, at least
 * one of these phrases appears.
 */
const OPTIONAL_MARKERS: readonly string[] = [
  'if available',
  'if wired up',
  'if registered',
  'if present',
  'wired up in this server build',
  'registered in this server build',
  "isn't wired up",
  "aren't wired up",
  "aren't available",
  "isn't available",
];

/**
 * Pull every backticked tool-like identifier out of the prompt body.
 * A "tool-like" identifier is a snake_case bareword (no dots, no
 * slashes) — the same shape MCP tool names use.
 */
function extractReferencedTools(body: string): string[] {
  const matches: string[] = [];
  const pattern = /`([a-z][a-z0-9_]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    if (name.includes('_') && !matches.includes(name)) matches.push(name);
  }
  return matches;
}

describe('MEGA_AUDIT_INSTRUCTIONS', () => {
  it('only references tools that are registered or explicitly optional', () => {
    const referenced = extractReferencedTools(MEGA_AUDIT_INSTRUCTIONS);

    // Drop anything that is obviously not a tool name: phase labels
    // ('starting', 'inventory', etc), schema field names ('audit_id',
    // 'per_source_token_budget'), filenames, etc. The simple test:
    // tool names exist in REGISTERED_TOOLS or OPTIONAL_TOOLS.
    const known = new Set<string>([...REGISTERED_TOOLS, ...OPTIONAL_TOOLS]);

    // The set of identifiers in the prompt that *look like* tools
    // (snake_case bareword in backticks) and aren't in the known set.
    // Schema field names like `audit_id`, `per_source_token_budget`,
    // `payload_json`, phase enum values, etc. are filtered by the
    // allowlist below — they are deliberately scoped, not tool calls.
    const SCHEMA_FIELDS_ALLOWLIST = new Set<string>([
      'audit_id',
      'per_source_token_budget',
      'payload_json',
      'from_self',
    ]);

    const unknown = referenced.filter((name) => !known.has(name) && !SCHEMA_FIELDS_ALLOWLIST.has(name));

    // Anything left must be flagged: the prompt references an
    // identifier this test doesn't recognise as either a registered
    // tool, an optional tool, or an allowlisted schema field. Fail
    // with a precise message so the contributor can choose:
    // (1) add it to REGISTERED_TOOLS + register it in cli.ts,
    // (2) add it to OPTIONAL_TOOLS + mark it optional in the prompt, or
    // (3) add it to SCHEMA_FIELDS_ALLOWLIST if it's a schema field.
    expect(unknown, `unknown identifiers referenced in prompt: ${unknown.join(', ')}`).toEqual([]);
  });

  it('marks every optional tool reference with an "if available"-style qualifier', () => {
    for (const tool of OPTIONAL_TOOLS) {
      // Find every occurrence of the tool name and check there's an
      // optional-marker phrase within ~400 chars on either side. The
      // window must cover the typical sentence-or-two that documents
      // the optional fallback — sentences in this prompt run long.
      const occurrences: number[] = [];
      let idx = MEGA_AUDIT_INSTRUCTIONS.indexOf(tool);
      while (idx !== -1) {
        occurrences.push(idx);
        idx = MEGA_AUDIT_INSTRUCTIONS.indexOf(tool, idx + 1);
      }

      expect(occurrences.length, `optional tool "${tool}" must appear in the prompt`).toBeGreaterThan(0);

      for (const at of occurrences) {
        const window = MEGA_AUDIT_INSTRUCTIONS.slice(Math.max(0, at - 400), at + tool.length + 400).toLowerCase();
        const marked = OPTIONAL_MARKERS.some((marker) => window.includes(marker));
        expect(
          marked,
          `optional tool "${tool}" referenced near char ${at} without an "if available"-style qualifier within 400 chars`,
        ).toBe(true);
      }
    }
  });

  it('disallows references to optional tools without a fallback path', () => {
    // Sanity: the prompt must also describe the fallback for every
    // optional tool. We approximate "fallback described" by looking
    // for keywords that signal a fallback path within ~500 chars of
    // any mention of the tool. The fallback for Phase 0's pair of
    // optional tools is documented in a sentence at the end of that
    // phase covering both, so the window has to be wide enough to
    // cross sentence boundaries.
    const FALLBACK_KEYWORDS = [
      'fall back',
      'fallback',
      'otherwise',
      'skip',
      "isn't present",
      "aren't wired",
      'continue with',
      'transcript-only',
    ];
    for (const tool of OPTIONAL_TOOLS) {
      let idx = MEGA_AUDIT_INSTRUCTIONS.indexOf(tool);
      let sawFallback = false;
      while (idx !== -1) {
        const window = MEGA_AUDIT_INSTRUCTIONS.slice(Math.max(0, idx - 500), idx + tool.length + 500).toLowerCase();
        if (FALLBACK_KEYWORDS.some((kw) => window.includes(kw))) {
          sawFallback = true;
          break;
        }
        idx = MEGA_AUDIT_INSTRUCTIONS.indexOf(tool, idx + 1);
      }
      expect(sawFallback, `optional tool "${tool}" referenced without a documented fallback path`).toBe(true);
    }
  });
});
