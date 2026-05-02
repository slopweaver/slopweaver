import { z } from 'zod';

/**
 * MCP bearer token format: `slop_mcp_<24 hex chars>`.
 *
 * Plaintext is returned to the user exactly once at issuance. The persisted
 * record stores only a bcrypt hash; the plaintext cannot be recovered.
 */
export const McpTokenStringSchema = z
  .string()
  .regex(/^slop_mcp_[0-9a-f]{24}$/, 'must be slop_mcp_<24 hex chars>');

export type McpTokenString = z.infer<typeof McpTokenStringSchema>;

/** A persisted MCP token record (no plaintext — only its bcrypt hash). */
export const McpTokenSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['*']),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

export type McpToken = z.infer<typeof McpTokenSchema>;

/** Request body for `POST /mcp/tokens`. */
export const McpTokenCreateInputSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

export type McpTokenCreateInput = z.infer<typeof McpTokenCreateInputSchema>;

/**
 * Response from `POST /mcp/tokens`. The plaintext bearer is included exactly
 * once here and never again; clients must save it on receipt.
 */
export const McpTokenCreateResponseSchema = z.object({
  token: McpTokenSchema,
  plaintext: McpTokenStringSchema,
});

export type McpTokenCreateResponse = z.infer<typeof McpTokenCreateResponseSchema>;

/** Response from `GET /mcp/tokens`. Plaintext is never returned here. */
export const McpTokenListResponseSchema = z.object({
  tokens: z.array(McpTokenSchema),
});

export type McpTokenListResponse = z.infer<typeof McpTokenListResponseSchema>;
