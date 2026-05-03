/**
 * Integration test for the createMcpServer + ping wiring.
 *
 * Pairs an `InMemoryTransport` with a real MCP `Client`, registers the ping
 * tool through the public registry surface, and asserts:
 *   - the tool appears in `tools/list`,
 *   - `tools/call` returns a `structuredContent` shape that matches the
 *     `PingResult` contract.
 *
 * No process I/O, no stdio — the in-memory transport is the same MCP wire
 * protocol so this catches schema regressions across the registry boundary.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PingResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.ts';
import { createPingTool } from './tools/builtin/ping.ts';

describe('createMcpServer + ping', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('registers ping and returns the v1 PingResult shape over an in-memory transport', async () => {
    // Arrange: deterministic uptime — startedAt 5s before now.
    const now = 1_762_000_000_000;
    const server = createMcpServer({
      db: dbHandle.db,
      version: '0.1.0',
      tools: [createPingTool({ version: '0.1.0', startedAtMs: now - 5_000, now: () => now })],
    });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // Assert: ping is advertised.
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('ping');

      const pingTool = list.tools.find((t) => t.name === 'ping');
      expect(pingTool?.description).toMatch(/smoke-test/i);
      // The MCP protocol requires inputSchema to be a JSON Schema object.
      expect(pingTool?.inputSchema.type).toBe('object');

      // Assert: tools/call returns the PingResult contract shape.
      const callResult = await client.callTool({ name: 'ping', arguments: {} });
      expect(callResult.isError).toBeUndefined();

      const parsed = PingResult.safeParse(callResult.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({ ok: true, version: '0.1.0', uptime_s: 5 });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns an MCP error result for an unknown tool name', async () => {
    const server = createMcpServer({
      db: dbHandle.db,
      version: '0.1.0',
      tools: [createPingTool({ version: '0.1.0', startedAtMs: Date.now() })],
    });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({ name: 'does-not-exist', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/does-not-exist/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
