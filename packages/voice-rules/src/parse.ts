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
 * writes (e.g. "Defaults", "Hard rules"). Unknown headings are skipped,
 * not errored, so users can freely add prose around the rules.
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
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('- ')) continue;
    const bullet = trimmed.slice(2).trim();
    const split = splitDirective(bullet);
    if (split === null) {
      // Prose bullet — silently skip. Lets users add notes/context.
      continue;
    }
    const ruleResult = makeRule({ directive: split.directive, body: split.body, line: i + 1 });
    if (ruleResult.isErr()) return err(ruleResult.error);
    rules.push(ruleResult.value);
  }
  return ok(Object.freeze(rules));
}

function makeRule({
  directive,
  body,
  line,
}: {
  directive: Directive;
  body: string;
  line: number;
}): Result<Rule, VoiceRulesError> {
  if (body.length === 0) {
    return err(VoiceRulesErrors.parseFailed({ line, raw: directive }));
  }
  if (directive === 'forbid') {
    return ok({ kind: 'forbid_token', token: body, line });
  }
  if (directive === 'replace') {
    const arrowIdx = body.indexOf(REPLACE_ARROW);
    if (arrowIdx === -1) {
      return err(VoiceRulesErrors.parseFailed({ line, raw: body }));
    }
    const pattern = body.slice(0, arrowIdx).trim();
    const replacement = body.slice(arrowIdx + REPLACE_ARROW.length).trim();
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
