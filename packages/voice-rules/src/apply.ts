/**
 * Apply a list of parsed rules to a draft string. Pure function: same
 * inputs → same outputs, no I/O.
 *
 * Edit ordering: rules apply in source order (top of the rules file
 * first). Each rule sees the output of the previous rule, not the
 * original draft. That's intentional — it lets later rules clean up
 * after earlier replacements (e.g. an em-dash → comma replacement
 * followed by a double-space cleanup).
 *
 * Failure mode for invalid regex: the rule is skipped with a count of
 * 0 and a one-line edit entry noting the skip. The draft passes
 * through untouched. We never throw — callers depend on this being a
 * deterministic last-mile safety net that can't crash the send.
 */

import type { ApplyResult, Edit, Rule } from './types.ts';

export function applyVoiceRules(draft: string, rules: ReadonlyArray<Rule>): ApplyResult {
  let current = draft;
  const edits: Edit[] = [];
  for (const rule of rules) {
    if (rule.kind === 'forbid_token') {
      const lower = current.toLowerCase();
      const tokenLower = rule.token.toLowerCase();
      let count = 0;
      let cursor = 0;
      // Walk and strip. We rebuild the output incrementally rather than
      // using a regex so we can do a case-insensitive substring strip
      // without escaping regex metacharacters in the token.
      let out = '';
      while (cursor < current.length) {
        const idx = lower.indexOf(tokenLower, cursor);
        if (idx === -1) {
          out += current.slice(cursor);
          break;
        }
        out += current.slice(cursor, idx);
        cursor = idx + rule.token.length;
        count += 1;
      }
      if (count > 0) {
        current = collapseWhitespace(out);
        edits.push({
          ruleLine: rule.line,
          kind: rule.kind,
          description: `forbid: stripped "${rule.token}" ×${count}`,
          count,
        });
      }
      continue;
    }
    if (rule.kind === 'replace') {
      const regex = safeRegex(rule.pattern);
      if (regex === null) {
        edits.push({
          ruleLine: rule.line,
          kind: rule.kind,
          description: `replace: invalid regex /${rule.pattern}/ — skipped`,
          count: 0,
        });
        continue;
      }
      let count = 0;
      const next = current.replace(regex, () => {
        count += 1;
        return rule.replacement;
      });
      if (count > 0) {
        current = collapseWhitespace(next);
        edits.push({
          ruleLine: rule.line,
          kind: rule.kind,
          description: `replace: /${rule.pattern}/ → "${rule.replacement}" ×${count}`,
          count,
        });
      }
      continue;
    }
    // rule.kind is narrowed to 'disallow_pattern' here — TS has exhausted
    // 'forbid_token' and 'replace' via the early-`continue`s above. We
    // run unconditionally to keep ESLint's no-unnecessary-condition happy.
    const regex = safeRegex(rule.pattern);
    if (regex === null) {
      edits.push({
        ruleLine: rule.line,
        kind: rule.kind,
        description: `pattern: invalid regex /${rule.pattern}/ — skipped`,
        count: 0,
      });
      continue;
    }
    let count = 0;
    const next = current.replace(regex, () => {
      count += 1;
      return '';
    });
    if (count > 0) {
      current = collapseWhitespace(next);
      edits.push({
        ruleLine: rule.line,
        kind: rule.kind,
        description: `pattern: stripped /${rule.pattern}/ ×${count}`,
        count,
      });
    }
  }
  return { rewritten: current, edits: Object.freeze(edits) };
}

/**
 * Collapse two or more spaces into one, but preserve newlines. After
 * stripping a forbidden token we often leave `"foo  bar"` — this pass
 * tidies that to `"foo bar"`. Idempotent.
 */
function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
}

/**
 * Compile a regex with the `g` flag. Returns `null` if the source
 * doesn't parse — callers treat that as a no-op for the rule.
 */
function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, 'g');
  } catch {
    return null;
  }
}
