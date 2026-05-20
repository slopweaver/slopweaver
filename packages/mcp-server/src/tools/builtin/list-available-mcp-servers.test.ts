/**
 * Tests for `list_available_mcp_servers`. The tool returns a static
 * curated catalog — we assert shape + uniqueness of slugs, presence of
 * the canonical entries, and that every entry has a non-empty
 * `tool_namespace_prefix` and `purpose`.
 */

import { ListAvailableMcpServersResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createListAvailableMcpServersTool, KNOWN_MCP_SERVERS } from './list-available-mcp-servers.ts';

describe('createListAvailableMcpServersTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns a non-empty, schema-valid catalog with unique slugs', async () => {
    const tool = createListAvailableMcpServersTool({
      now: () => new Date('2026-05-21T10:00:00Z'),
    });
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = ListAvailableMcpServersResult.parse(result.value);
      expect(parsed.catalog.length).toBeGreaterThanOrEqual(5);
      expect(parsed.generated_at).toBe('2026-05-21T10:00:00.000Z');
      const slugs = parsed.catalog.map((e) => e.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const entry of parsed.catalog) {
        expect(entry.tool_namespace_prefix.startsWith('mcp__')).toBe(true);
        expect(entry.delta_filename.endsWith('-delta.md')).toBe(true);
        expect(entry.purpose.length).toBeGreaterThan(0);
      }
    }
  });

  it('includes the canonical github/slack/linear/gmail entries', async () => {
    const tool = createListAvailableMcpServersTool();
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = ListAvailableMcpServersResult.parse(result.value);
      const slugs = parsed.catalog.map((e: { slug: string }) => e.slug);
      for (const expected of ['github', 'slack', 'linear', 'gmail', 'google-calendar', 'notion']) {
        expect(slugs).toContain(expected);
      }
    }
  });

  it('matches the publicly-exported KNOWN_MCP_SERVERS list', async () => {
    const tool = createListAvailableMcpServersTool();
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = ListAvailableMcpServersResult.parse(result.value);
      expect(parsed.catalog.length).toBe(KNOWN_MCP_SERVERS.length);
    }
  });
});
