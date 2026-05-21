/**
 * Shared types for the voice-rules engine. Kept narrow so the rule
 * shape is easy to extend with new directives later.
 */

export type ForbidTokenRule = {
  readonly kind: 'forbid_token';
  /** Case-insensitive substring. Stripped from the draft; flagged in the edit log. */
  readonly token: string;
  /** Line in the source markdown the rule was parsed from. */
  readonly line: number;
};

export type ReplaceRule = {
  readonly kind: 'replace';
  /** Source regex pattern. Compiled with the `g` flag inside `applyRules`. */
  readonly pattern: string;
  /** Replacement string. Empty string is valid (= delete on match). */
  readonly replacement: string;
  readonly line: number;
};

export type DisallowPatternRule = {
  readonly kind: 'disallow_pattern';
  /** Regex pattern; matches are stripped from the draft and flagged. */
  readonly pattern: string;
  readonly line: number;
};

export type Rule = ForbidTokenRule | ReplaceRule | DisallowPatternRule;

/**
 * One entry in the edit log returned by `applyRules`. Records what the
 * rule did so callers can surface it ("rewrote 3 phrases per voice rules").
 */
export type Edit = {
  readonly ruleLine: number;
  readonly kind: Rule['kind'];
  readonly description: string;
  /** Number of substitutions or strips this rule applied to the draft. */
  readonly count: number;
};

export type ApplyResult = {
  readonly rewritten: string;
  readonly edits: ReadonlyArray<Edit>;
};
