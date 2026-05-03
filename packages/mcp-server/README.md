# @slopweaver/mcp-server

Framework-agnostic MCP server for SlopWeaver. Owns the tool registry, the
builtin `ping` tool, and the stdio transport helper. Consumed as TypeScript
source (`main: ./src/index.ts`); no build step.

## API

- `createMcpServer({ db, tools, version })` — registers each `Tool` against an
  `@modelcontextprotocol/sdk` `McpServer` and returns it. Caller owns
  lifecycle (transport connection, shutdown).
- `createPingTool({ version, startedAtMs })` — builtin smoke-test tool.
  Returns `{ ok: true, version, uptime_s }` per the `PingResult` contract.
- `startStdio({ server })` — convenience wrapper that constructs a
  `StdioServerTransport` and calls `server.connect()`. v1 ships stdio-only
  per decision #11; HTTP/auth lands in v2 cloud-tier.
- `Tool`, `ToolHandler`, `ToolHandlerContext` — registry types. A `Tool`
  declares Zod input/output schemas (typically from `@slopweaver/contracts`)
  and an async handler that receives the parsed input plus a context bag.

## Scope

- v1: stdio transport, builtin `ping`, registry surface for the composite
  tools that land in subsequent PRs.
- Out of scope here: composite tools (`start_session`, `catch_me_up`, …),
  HTTP transport, OAuth/auth, integrations.

## Development

```bash
pnpm --filter @slopweaver/mcp-server compile
pnpm --filter @slopweaver/mcp-server test
```

The integration test pairs an `InMemoryTransport` with a real MCP `Client`,
so it catches regressions in tool registration without spawning a process.
