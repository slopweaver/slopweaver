/**
 * CLI adapter for `slopweaver notion-upload-image`. Resolves config
 * from flags + env, hands off to `uploadNotionImage`, prints a
 * one-line outcome.
 */

import { uploadNotionImage } from './upload.ts';
import type { NotionUploadError } from './errors.ts';
import type { NotionUploadConfig, UploadImageResult } from './types.ts';

export type NotionUploadFlags = {
  readonly page: string;
  readonly image: string;
  readonly tokenV2?: string;
  readonly userId?: string;
  readonly workspaceUrl?: string;
};

export type NotionUploadIo = {
  readonly stdout: { write: (s: string) => void };
  readonly stderr: { write: (s: string) => void };
  readonly env: Readonly<Record<string, string | undefined>>;
};

export function resolveConfig({
  flags,
  env,
}: {
  flags: NotionUploadFlags;
  env: Readonly<Record<string, string | undefined>>;
}): { ok: true; config: NotionUploadConfig } | { ok: false; error: string } {
  const tokenV2 = flags.tokenV2 ?? env['NOTION_TOKEN_V2'];
  if (tokenV2 === undefined || tokenV2.length === 0) {
    return {
      ok: false,
      error: 'no token_v2 cookie. Pass --token-v2 or set NOTION_TOKEN_V2. Extract from a logged-in Notion browser tab.',
    };
  }
  const userId = flags.userId ?? env['NOTION_USER_ID'];
  const apiBaseUrl = flags.workspaceUrl ?? env['SLOPWEAVER_NOTION_API_BASE'];
  return {
    ok: true,
    config: {
      tokenV2,
      ...(userId !== undefined && userId.length > 0 ? { userId } : {}),
      ...(apiBaseUrl !== undefined && apiBaseUrl.length > 0 ? { apiBaseUrl } : {}),
    },
  };
}

function formatErrorLine({ error }: { error: NotionUploadError }): string {
  return `notion-upload-image: ${error.code} ${error.message}`;
}

function formatSuccessLine({ result, pageRef }: { result: UploadImageResult; pageRef: string }): string {
  return `notion-upload-image: ok block=${result.blockId} file=${result.fileUuid} page=${result.pageUrl} input=${pageRef}`;
}

export async function runNotionUploadImage({
  flags,
  io,
}: {
  flags: NotionUploadFlags;
  io: NotionUploadIo;
}): Promise<number> {
  const resolved = resolveConfig({ flags, env: io.env });
  if (!resolved.ok) {
    io.stderr.write(`notion-upload-image: ${resolved.error}\n`);
    return 2;
  }
  const result = await uploadNotionImage({
    config: resolved.config,
    pageRef: flags.page,
    imagePath: flags.image,
  });
  if (result.isErr()) {
    io.stderr.write(`${formatErrorLine({ error: result.error })}\n`);
    return result.error.code === 'NOTION_INVALID_PAGE_REF' ? 2 : 1;
  }
  io.stdout.write(`${formatSuccessLine({ result: result.value, pageRef: flags.page })}\n`);
  return 0;
}
