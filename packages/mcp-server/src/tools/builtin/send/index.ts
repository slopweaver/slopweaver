/**
 * Send-via-source barrel. Two tools: `prepare_send` (parse + validate
 * + return platform-specific send instructions) and `record_send_outcome`
 * (append-only JSONL log of every send attempt).
 *
 * Slopweaver's MCP server can't call other MCP servers across the SDK
 * boundary, so the actual platform send happens in the model's
 * follow-up tool call after `prepare_send` returns.
 */

export { createPrepareSendTool } from './prepare-send.ts';
export type { CreatePrepareSendToolArgs } from './prepare-send.ts';
export { createRecordSendOutcomeTool } from './record-send-outcome.ts';
export type { CreateRecordSendOutcomeToolArgs } from './record-send-outcome.ts';
export { parseTarget } from './parse-target.ts';
export type { ParsedTarget } from './parse-target.ts';
export { parseFrontmatter } from './parse-frontmatter.ts';
export type { ParsedDraft } from './parse-frontmatter.ts';
