/**
 * Pure formatter for voice-rule directives. Always emits exactly the
 * shape `@slopweaver/voice-rules` parses: a single bullet per line,
 * the directive keyword + colon, then the body.
 */

import type { VoiceDirective } from './types.ts';

export function formatDirective({ directive }: { directive: VoiceDirective }): string {
  switch (directive.type) {
    case 'forbid':
      return `- forbid: ${directive.token}`;
    case 'replace':
      return `- replace: ${directive.from} => ${directive.to}`;
    case 'pattern':
      return `- pattern: ${directive.regex}`;
  }
}
