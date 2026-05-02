/**
 * @slopweaver/contracts — Zod schemas + ts-rest contracts shared between
 * SlopWeaver apps and MCP clients.
 *
 * v1 surface is small (one MCP token contract) and grows as new endpoints
 * land. ts-rest contract definitions arrive once `apps/cloud/` adds the
 * REST endpoints they describe.
 */
export * from './mcp/token.js';
