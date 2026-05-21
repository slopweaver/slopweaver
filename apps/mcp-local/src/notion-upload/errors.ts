import type { BaseError } from '@slopweaver/errors';

export interface NotionInvalidPageRefError extends BaseError {
  readonly code: 'NOTION_INVALID_PAGE_REF';
  readonly pageRef: string;
}

export interface NotionImageReadError extends BaseError {
  readonly code: 'NOTION_IMAGE_READ_FAILED';
  readonly imagePath: string;
}

export interface NotionLoadChunkError extends BaseError {
  readonly code: 'NOTION_LOAD_CHUNK_FAILED';
  readonly httpStatus?: number;
}

export interface NotionUploadUrlError extends BaseError {
  readonly code: 'NOTION_UPLOAD_URL_FAILED';
  readonly httpStatus?: number;
}

export interface NotionBytesUploadError extends BaseError {
  readonly code: 'NOTION_BYTES_UPLOAD_FAILED';
  readonly httpStatus?: number;
}

export interface NotionSaveTransactionsError extends BaseError {
  readonly code: 'NOTION_SAVE_TRANSACTIONS_FAILED';
  readonly httpStatus?: number;
}

export type NotionUploadError =
  | NotionInvalidPageRefError
  | NotionImageReadError
  | NotionLoadChunkError
  | NotionUploadUrlError
  | NotionBytesUploadError
  | NotionSaveTransactionsError;

export const NotionUploadErrors = {
  invalidPageRef: ({ pageRef }: { pageRef: string }): NotionInvalidPageRefError => ({
    code: 'NOTION_INVALID_PAGE_REF',
    message: `could not extract a 32-hex UUID from ${JSON.stringify(pageRef)}`,
    pageRef,
  }),
  imageReadFailed: ({ imagePath, cause }: { imagePath: string; cause: string }): NotionImageReadError => ({
    code: 'NOTION_IMAGE_READ_FAILED',
    message: `failed to read image at ${imagePath}: ${cause}`,
    imagePath,
  }),
  loadChunkFailed: ({ cause, httpStatus }: { cause: string; httpStatus?: number }): NotionLoadChunkError => ({
    code: 'NOTION_LOAD_CHUNK_FAILED',
    message: `loadPageChunk failed: ${cause}`,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }),
  uploadUrlFailed: ({ cause, httpStatus }: { cause: string; httpStatus?: number }): NotionUploadUrlError => ({
    code: 'NOTION_UPLOAD_URL_FAILED',
    message: `getUploadFileUrl failed: ${cause}`,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }),
  bytesUploadFailed: ({ cause, httpStatus }: { cause: string; httpStatus?: number }): NotionBytesUploadError => ({
    code: 'NOTION_BYTES_UPLOAD_FAILED',
    message: `binary PUT failed: ${cause}`,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }),
  saveTransactionsFailed: ({
    cause,
    httpStatus,
  }: {
    cause: string;
    httpStatus?: number;
  }): NotionSaveTransactionsError => ({
    code: 'NOTION_SAVE_TRANSACTIONS_FAILED',
    message: `saveTransactionsFanout failed: ${cause}`,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }),
} as const;
