/**
 * Schema barrel — re-exports every Drizzle table in @slopweaver/db.
 *
 * Consumed by Drizzle's `drizzle(sqlite, { schema })` and by drizzle-kit
 * (which scans `./src/schema` per `drizzle.config.ts`). Add new tables here
 * as they're introduced.
 */

export { evidenceLog } from './evidence-log.js';
export { identityGraph } from './identity-graph.js';
export { integrationState } from './integration-state.js';
export { workspaces } from './workspaces.js';
