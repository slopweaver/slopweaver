/**
 * Voice-rule directive shapes. Mirror the grammar parsed by the
 * `@slopweaver/voice-rules` package; this CLI is the upstream capture
 * surface that appends new directives to a markdown rules file.
 */

export type ForbidDirective = {
  readonly type: 'forbid';
  /** Bare token (e.g. `delve`). Stored verbatim. */
  readonly token: string;
};

export type ReplaceDirective = {
  readonly type: 'replace';
  readonly from: string;
  readonly to: string;
};

export type PatternDirective = {
  readonly type: 'pattern';
  /** Regex source (without surrounding slashes). */
  readonly regex: string;
};

export type VoiceDirective = ForbidDirective | ReplaceDirective | PatternDirective;
