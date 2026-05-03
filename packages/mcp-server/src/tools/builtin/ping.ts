/**
 * Builtin `ping` tool: the smoke-test surface for the MCP server. Returns the
 * server's reported version and process uptime in seconds. Useful for health
 * checks from MCP clients and for verifying the registry/transport wiring in
 * tests.
 */

import { PingArgs, PingResult } from '@slopweaver/contracts';
import { defineTool, type Tool } from '../registry.ts';

export type CreatePingToolArgs = {
  /** Server version string surfaced in the response. */
  version: string;
  /**
   * `performance.now()`-style monotonic millisecond timestamp captured when
   * the server was created. Injected so tests can pin uptime deterministically.
   */
  startedAtMs: number;
  /** Clock used to compute uptime; defaults to `Date.now`. */
  now?: () => number;
};

export function createPingTool({ version, startedAtMs, now = Date.now }: CreatePingToolArgs): Tool {
  return defineTool({
    name: 'ping',
    description: 'Smoke-test tool. Returns the server version and uptime in whole seconds.',
    inputSchema: PingArgs,
    outputSchema: PingResult,
    handler: async () => {
      const elapsedMs = Math.max(0, now() - startedAtMs);
      return {
        ok: true,
        version,
        uptime_s: Math.floor(elapsedMs / 1000),
      };
    },
  });
}
