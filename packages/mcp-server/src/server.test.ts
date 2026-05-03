/**
 * Integration test for the createMcpServer + registry wiring.
 *
 * Pairs an `InMemoryTransport` with a real MCP `Client` so the assertions
 * exercise the actual MCP wire protocol — `tools/list` schema discovery,
 * `tools/call` round-trips, and SDK-level input validation. No process I/O,
 * no stdio.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PingResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpServer } from './server.ts';
import { createPingTool } from './tools/builtin/ping.ts';
import { defineTool, type Tool } from './tools/registry.ts';

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
      // Assert: ping is advertised with an object-shaped JSON-Schema input.
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('ping');

      const pingTool = list.tools.find((t) => t.name === 'ping');
      expect(pingTool?.description).toMatch(/smoke-test/i);
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

  it('publishes input/output schema keys via tools/list (regression for ZodObject constraint)', async () => {
    // A tool with non-trivial input + output object schemas must round-trip
    // its property keys through tools/list — otherwise MCP clients can't
    // discover argument shapes. This pins the registry's ZodObject contract.
    const echoTool = defineTool({
      name: 'echo',
      description: 'Returns the message and a length.',
      inputSchema: z.object({ message: z.string().min(1) }).strict(),
      outputSchema: z
        .object({ message: z.string(), length: z.number().int().nonnegative() })
        .strict(),
      handler: async ({ input }) => ({ message: input.message, length: input.message.length }),
    });

    const server = createMcpServer({
      db: dbHandle.db,
      version: '0.1.0',
      tools: [echoTool],
    });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const list = await client.listTools();
      const echo = list.tools.find((t) => t.name === 'echo');

      expect(echo).toBeDefined();
      expect(echo?.inputSchema.type).toBe('object');
      expect(Object.keys(echo?.inputSchema.properties ?? {})).toContain('message');
      expect(echo?.inputSchema.required).toContain('message');

      expect(echo?.outputSchema?.type).toBe('object');
      expect(Object.keys(echo?.outputSchema?.properties ?? {})).toEqual(
        expect.arrayContaining(['message', 'length']),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects invalid tool input at the SDK boundary without invoking the handler', async () => {
    // The defineTool soundness argument depends on McpServer validating
    // input against inputSchema *before* calling the handler. If that
    // invariant breaks, the handler runs on unvalidated data — exactly the
    // hole the type erasure assumes the SDK will plug.
    let handlerCalled = 0;

    const requireNameTool: Tool = defineTool({
      name: 'require-name',
      description: 'Test tool that requires a non-empty `name` field.',
      inputSchema: z.object({ name: z.string().min(1) }).strict(),
      outputSchema: z.object({ greeting: z.string() }).strict(),
      handler: async ({ input }) => {
        handlerCalled += 1;
        return { greeting: `hello, ${input.name}` };
      },
    });

    const server = createMcpServer({
      db: dbHandle.db,
      version: '0.1.0',
      tools: [requireNameTool],
    });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // Missing required `name`.
      const missing = await client.callTool({ name: 'require-name', arguments: {} });
      expect(missing.isError).toBe(true);
      expect(handlerCalled).toBe(0);

      // Wrong type for `name`.
      const wrongType = await client.callTool({
        name: 'require-name',
        arguments: { name: 42 } as unknown as Record<string, unknown>,
      });
      expect(wrongType.isError).toBe(true);
      expect(handlerCalled).toBe(0);

      // Sanity-check: a valid call DOES invoke the handler.
      const ok = await client.callTool({
        name: 'require-name',
        arguments: { name: 'world' },
      });
      expect(ok.isError).toBeUndefined();
      expect(handlerCalled).toBe(1);
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
