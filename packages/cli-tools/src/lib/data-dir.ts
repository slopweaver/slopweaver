import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where SlopWeaver stores its local data (database, cached tokens, logs).
 *
 * Cross-platform: `~/.slopweaver` everywhere. We can move to platform-native
 * data dirs (Library/Application Support on macOS, %LOCALAPPDATA% on Windows,
 * $XDG_DATA_HOME on Linux) when there's a reason to — for v1 a single
 * predictable path is easier to document and debug.
 */
export function resolveDataDir({ home }: { home?: string } = {}): string {
  return join(home ?? homedir(), '.slopweaver');
}
