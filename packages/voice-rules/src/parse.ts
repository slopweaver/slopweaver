/**
 * Markdown → Rule[] parser for `rules/communication-style.md`.
 *
 * The expected shape mirrors what `/style-rule` writes to disk. Each rule
 * is a bullet line under a known sub-heading; the bullet text follows
 * one of three patterns:
 *
 *   - `forbid: <token>` — case-insensitive substring match; flagged + stripped.
 *   - `replace: <pattern> => <replacement>` — regex match + replacement.
 *   - `pattern: <regex>` — flag any match; strip the match from output.
 *
 * Anything else under a known sub-heading is treated as commentary and
 * preserved silently. Sub-heading names match what the bootstrap seed
 * writes (e.g. "Defaults", "Hard rules"). Unknown sub-headings switch
 * the parser into an inert state so a section like "Examples" or "Notes"
 * can demonstrate forbidden phrases without those bullets being treated
 * as live directives. Top-level (`#`) headings are treated as the
 * document title and do not switch context.
 */

import { type Result, err, ok } from '@slopweaver/errors';
import { type VoiceRulesError, VoiceRulesErrors } from './errors.ts';
import type { Rule } from './types.ts';

// Detect directive prefixes via `startsWith` rather than a regex —
// the codebase's eslint-plugin-regexp catches polynomial-backtracking
// risk for `keyword:\s*(.*)` patterns. A literal-prefix check is both
// simpler and unambiguously linear.
const DIRECTIVES = ['forbid', 'replace', 'pattern'] as const;
type Directive = (typeof DIRECTIVES)[number];
const REPLACE_ARROW = '=>';

// Sub-headings that hold live directives. Anything else (e.g. "Examples",
// "Notes", "References") flips the parser into an inert section so
// illustrative bullets can quote forbidden phrases without firing. The
// allowlist is intentionally lowercased + trimmed for case-insensitive
// comparison.
const RULE_SECTION_HEADINGS: ReadonlySet<string> = new Set(['defaults', 'hard rules']);

// Headings can use ATX prefixes (#, ##, ###, …). The literal-prefix
// approach (one branch per depth up to ######) avoids a regex with a
// variable-length `#` capture, which eslint-plugin-regexp would flag.
const ATX_PREFIXES = ['######', '#####', '####', '###', '##', '#'] as const;

type HeadingInfo = { depth: number; text: string };

function parseHeading(line: string): HeadingInfo | null {
  const trimmed = line.trimStart();
  for (const prefix of ATX_PREFIXES) {
    if (trimmed.startsWith(`${prefix} `)) {
      return { depth: prefix.length, text: trimmed.slice(prefix.length + 1).trim() };
    }
  }
  return null;
}

// Matches a bullet body that opens with a single keyword followed by
// `:` — used to distinguish a typoed directive (`replcae: foo => bar`)
// from a plain prose bullet (`Honest hedges over false confidence.`).
// The keyword is restricted to ASCII letters/underscores so URLs and
// arbitrary prose with a colon don't trip the check.
function looksLikeDirective(bullet: string): boolean {
  const colon = bullet.indexOf(':');
  if (colon <= 0) return false;
  const keyword = bullet.slice(0, colon);
  if (keyword.length === 0) return false;
  for (let i = 0; i < keyword.length; i += 1) {
    const ch = keyword.charCodeAt(i);
    const isLower = ch >= 97 && ch <= 122;
    const isUpper = ch >= 65 && ch <= 90;
    const isUnderscore = ch === 95;
    if (!isLower && !isUpper && !isUnderscore) return false;
  }
  return true;
}

function splitDirective(bullet: string): { directive: Directive; body: string } | null {
  const lower = bullet.toLowerCase();
  for (const directive of DIRECTIVES) {
    const prefix = `${directive}:`;
    if (lower.startsWith(prefix)) {
      return { directive, body: bullet.slice(prefix.length).trim() };
    }
  }
  return null;
}

export function parseVoiceRules(markdown: string): Result<ReadonlyArray<Rule>, VoiceRulesError> {
  const rules: Rule[] = [];
  const lines = markdown.split('\n');
  // Before any sub-heading, directives are active — this preserves the
  // "raw bullet list with no headings" shape (`- forbid: delve`).
  let inRuleSection = true;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw == null) continue;
    const heading = parseHeading(raw);
    if (heading !== null) {
      // Depth-1 (`#`) is the document title — leave the section state
      // untouched. Sub-headings (`##`+) gate the parser: known rule
      // sections activate it, everything else (Examples / Notes / ad-hoc
      // prose sections) makes it inert.
      if (heading.depth >= 2) {
        inRuleSection = RULE_SECTION_HEADINGS.has(heading.text.toLowerCase());
      }
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed.startsWith('- ')) continue;
    if (!inRuleSection) continue;
    const bullet = trimmed.slice(2).trim();
    const split = splitDirective(bullet);
    if (split === null) {
      // Bullets that look like `<keyword>: …` but aren't a recognized
      // directive are typos (`replcae: foo => bar`) — reject loudly so
      // they don't silently no-op. Plain prose bullets without a leading
      // `<keyword>:` shape stay welcome.
      if (looksLikeDirective(bullet)) {
        return err(VoiceRulesErrors.parseFailed({ line: i + 1, raw: bullet }));
      }
      continue;
    }
    const ruleResult = makeRule({ directive: split.directive, body: split.body, line: i + 1, raw });
    if (ruleResult.isErr()) return err(ruleResult.error);
    rules.push(ruleResult.value);
  }
  return ok(Object.freeze(rules));
}

function makeRule({
  directive,
  body,
  line,
  raw,
}: {
  directive: Directive;
  body: string;
  line: number;
  raw: string;
}): Result<Rule, VoiceRulesError> {
  if (body.length === 0) {
    return err(VoiceRulesErrors.parseFailed({ line, raw: directive }));
  }
  if (directive === 'forbid') {
    return ok({ kind: 'forbid_token', token: body, line });
  }
  if (directive === 'replace') {
    // The arrow position has to be located on `body` (already
    // post-`forbid:`-prefix-trimmed), but the replacement substring is
    // preserved verbatim from the *original* line. `.trim()` on the
    // replacement would silently collapse `"-- => , "` to `","`, eating
    // the trailing space a user typed for "em-dash → comma + space".
    const arrowIdx = body.indexOf(REPLACE_ARROW);
    if (arrowIdx === -1) {
      return err(VoiceRulesErrors.parseFailed({ line, raw: body }));
    }
    const pattern = body.slice(0, arrowIdx).trim();
    const replacement = extractVerbatimReplacement({ raw, body });
    if (pattern.length === 0) {
      return err(VoiceRulesErrors.parseFailed({ line, raw: body }));
    }
    return ok({
      kind: 'replace',
      pattern,
      replacement,
      line,
    });
  }
  // directive is narrowed to 'pattern' here.
  return ok({ kind: 'disallow_pattern', pattern: body, line });
}

/**
 * Pull the replacement substring out of the original line, preserving
 * whitespace exactly as the user wrote it after `=>`. The single space
 * conventionally written as the delimiter between `=>` and the
 * replacement is consumed — so `- replace: -- => , ` yields `", "` (the
 * trailing space the user typed for "em-dash → comma + space" is kept),
 * and `- replace: \bnotably\b => ` (one trailing space) yields `""`
 * (an empty-string replacement, i.e. delete on match).
 *
 * Falls back to the `body`-based extraction if the raw line shape is
 * unexpected (defensive guard — `body` always contains the arrow at this
 * point, so the fallback path is unreachable in practice but keeps the
 * function total).
 */
function extractVerbatimReplacement({ raw, body }: { raw: string; body: string }): string {
  const arrowInRaw = raw.indexOf(REPLACE_ARROW);
  const source = arrowInRaw !== -1 ? raw : body;
  const arrowIdx = source.indexOf(REPLACE_ARROW);
  const afterArrow = source.slice(arrowIdx + REPLACE_ARROW.length);
  // Consume exactly one space delimiter — the visual separator between
  // `=>` and the replacement. Any additional whitespace is part of the
  // replacement and must be preserved verbatim.
  return afterArrow.startsWith(' ') ? afterArrow.slice(1) : afterArrow;
}
