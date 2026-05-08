/**
 * Schema barrel — re-exports every Drizzle table in @slopweaver/db.
 *
 * Consumed by Drizzle's `drizzle(sqlite, { schema })` and by drizzle-kit
 * (which scans `./src/schema` per `drizzle.config.ts`). Add new tables here
 * as they're introduced.
 */

export { evidenceLog } from './evidence-log.ts';
export { identityGraph } from './identity-graph.ts';
export { integrationState } from './integration-state.ts';
export { integrationTokens } from './integration-tokens.ts';
export { workspaces } from './workspaces.ts';
