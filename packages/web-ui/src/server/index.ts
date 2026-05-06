/**
 * Public entry for `apps/mcp-local` (and any other consumer that wants to host
 * the Diagnostics UI alongside its own process).
 */

export { startWebUiServer, DEFAULT_HOST, DEFAULT_PORT } from './start.ts';
export type { StartWebUiServerOptions, WebUiServerHandle } from './start.ts';
export { CLIENT_ASSETS_DIR } from './static-dir.ts';
export type {
  DiagnosticsResponse,
  EnvCheck,
  EnvCheckStatus,
  IntegrationStatus,
} from './types.ts';
export { STALE_THRESHOLD_MS } from './types.ts';
