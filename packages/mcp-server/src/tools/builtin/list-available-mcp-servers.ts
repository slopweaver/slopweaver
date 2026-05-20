/**
 * `list_available_mcp_servers` MCP tool. Returns a static catalog of the
 * MCP servers SlopWeaver knows how to use — namespace prefix, delta
 * filename, one-line purpose. Used by the fan-out and session-start
 * prompts as a hint sheet so they don't have to enumerate possibilities
 * inline.
 *
 * This tool intentionally does NOT inspect the actual MCP client's
 * connected-servers list (we can't reach across the SDK boundary).
 * Discovering "which of these does the user actually have connected" is
 * the prompt's job — it inspects the `mcp__*__*` tool namespace at call
 * time. This catalog tells it WHICH PREFIXES TO LOOK FOR.
 */

import { ListAvailableMcpServersArgs, ListAvailableMcpServersResult } from '@slopweaver/contracts';
import { ok } from '@slopweaver/errors';
import { defineTool, type Tool } from '../registry.ts';

type CatalogEntry = {
  slug: string;
  displayName: string;
  namespacePrefix: string;
  deltaFilename: string;
  purpose: string;
};

const CATALOG: ReadonlyArray<CatalogEntry> = [
  {
    slug: 'github',
    displayName: 'GitHub',
    namespacePrefix: 'mcp__github__',
    deltaFilename: 'github-delta.md',
    purpose: 'PRs (authored + review-requested + mentioned), issues, commits, CI status, recently merged.',
  },
  {
    slug: 'slack',
    displayName: 'Slack',
    namespacePrefix: 'mcp__slack__',
    deltaFilename: 'slack-delta.md',
    purpose: 'DMs, mentions, priority channel sweeps, thread expansion. Watermark-bounded.',
  },
  {
    slug: 'linear',
    displayName: 'Linear',
    namespacePrefix: 'mcp__linear__',
    deltaFilename: 'linear-delta.md',
    purpose: 'Assigned tickets, mentions, status transitions, current cycle.',
  },
  {
    slug: 'gmail',
    displayName: 'Gmail',
    namespacePrefix: 'mcp__gmail__',
    deltaFilename: 'gmail-delta.md',
    purpose: 'Unread important threads, replies-owed, labels.',
  },
  {
    slug: 'google-calendar',
    displayName: 'Google Calendar',
    namespacePrefix: 'mcp__calendar__',
    deltaFilename: 'calendar-delta.md',
    purpose: "Today's events, focus blocks, recurring 1:1s.",
  },
  {
    slug: 'notion',
    displayName: 'Notion',
    namespacePrefix: 'mcp__notion__',
    deltaFilename: 'notion-delta.md',
    purpose: 'Recently edited pages, databases the user owns, mentions.',
  },
  {
    slug: 'jira',
    displayName: 'Jira',
    namespacePrefix: 'mcp__jira__',
    deltaFilename: 'jira-delta.md',
    purpose: 'Assigned issues, mentions, current sprint.',
  },
  {
    slug: 'asana',
    displayName: 'Asana',
    namespacePrefix: 'mcp__asana__',
    deltaFilename: 'asana-delta.md',
    purpose: 'Tasks assigned to me, due-today, mentions.',
  },
  {
    slug: 'hubspot',
    displayName: 'HubSpot',
    namespacePrefix: 'mcp__hubspot__',
    deltaFilename: 'hubspot-delta.md',
    purpose: 'Open deals owned, contacts updated recently, follow-ups due.',
  },
  {
    slug: 'mixpanel',
    displayName: 'Mixpanel',
    namespacePrefix: 'mcp__mixpanel__',
    deltaFilename: 'mixpanel-delta.md',
    purpose: 'Saved reports, dashboards, recent funnel changes.',
  },
  {
    slug: 'stripe',
    displayName: 'Stripe',
    namespacePrefix: 'mcp__stripe__',
    deltaFilename: 'stripe-delta.md',
    purpose: 'Recent disputes, failed payments, subscription churn.',
  },
];

export function createListAvailableMcpServersTool(args: { now?: () => Date } = {}): Tool {
  const now = args.now ?? (() => new Date());
  return defineTool({
    name: 'list_available_mcp_servers',
    description:
      'Returns a static catalog of MCP servers SlopWeaver knows how to use: slug, namespace prefix, delta filename, one-line purpose. Use this to discover which `mcp__*__*` tool prefixes to look for at fan-out time.',
    inputSchema: ListAvailableMcpServersArgs,
    outputSchema: ListAvailableMcpServersResult,
    handler: async () => {
      return ok({
        catalog: CATALOG.map((entry) => ({
          slug: entry.slug,
          display_name: entry.displayName,
          tool_namespace_prefix: entry.namespacePrefix,
          delta_filename: entry.deltaFilename,
          purpose: entry.purpose,
        })),
        generated_at: now().toISOString(),
      });
    },
  });
}

/** Exported for tests / docs — the same list, in its source-order shape. */
export const KNOWN_MCP_SERVERS: ReadonlyArray<CatalogEntry> = CATALOG;
