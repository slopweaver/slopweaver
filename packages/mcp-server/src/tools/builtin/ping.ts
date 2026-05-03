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
   * Wall-clock millisecond timestamp (Unix epoch, as returned by
   * `Date.now()`) captured when the server started. Must share a clock
   * domain with `now`; mixing `Date.now()` with `performance.now()` produces
   * nonsense uptime values.
   */
  startedAtMs: number;
  /**
   * Clock used to compute uptime. Must share a domain with `startedAtMs`.
   * Defaults to `Date.now`. Injected so tests can pin uptime deterministically.
   */
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
        ok: true as const,
        version,
        uptime_s: Math.floor(elapsedMs / 1000),
      };
    },
  });
}
