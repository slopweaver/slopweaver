import type { BaseError } from '@slopweaver/errors';

export interface SlackImageInvalidTokenError extends BaseError {
  readonly code: 'SLACK_IMAGE_INVALID_TOKEN';
}

export interface SlackImageImageReadError extends BaseError {
  readonly code: 'SLACK_IMAGE_READ_FAILED';
  readonly imagePath: string;
}

export interface SlackImageUploadUrlError extends BaseError {
  readonly code: 'SLACK_IMAGE_UPLOAD_URL_FAILED';
  readonly slackError?: string;
}

export interface SlackImageBytesUploadError extends BaseError {
  readonly code: 'SLACK_IMAGE_BYTES_UPLOAD_FAILED';
  readonly httpStatus?: number;
}

export interface SlackImageCompleteError extends BaseError {
  readonly code: 'SLACK_IMAGE_COMPLETE_FAILED';
  readonly slackError?: string;
}

export interface SlackImageShareError extends BaseError {
  readonly code: 'SLACK_IMAGE_SHARE_FAILED';
  readonly slackError?: string;
}

export type SlackImageError =
  | SlackImageInvalidTokenError
  | SlackImageImageReadError
  | SlackImageUploadUrlError
  | SlackImageBytesUploadError
  | SlackImageCompleteError
  | SlackImageShareError;

export const SlackImageErrors = {
  invalidToken: (): SlackImageInvalidTokenError => ({
    code: 'SLACK_IMAGE_INVALID_TOKEN',
    message: 'xoxc token must begin with "xoxc-".',
  }),
  imageReadFailed: ({ imagePath, cause }: { imagePath: string; cause: string }): SlackImageImageReadError => ({
    code: 'SLACK_IMAGE_READ_FAILED',
    message: `failed to read image at ${imagePath}: ${cause}`,
    imagePath,
  }),
  uploadUrlFailed: ({ cause, slackError }: { cause: string; slackError?: string }): SlackImageUploadUrlError => ({
    code: 'SLACK_IMAGE_UPLOAD_URL_FAILED',
    message: `files.getUploadURL failed: ${cause}`,
    ...(slackError !== undefined ? { slackError } : {}),
  }),
  bytesUploadFailed: ({ cause, httpStatus }: { cause: string; httpStatus?: number }): SlackImageBytesUploadError => ({
    code: 'SLACK_IMAGE_BYTES_UPLOAD_FAILED',
    message: `binary upload failed: ${cause}`,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }),
  completeFailed: ({ cause, slackError }: { cause: string; slackError?: string }): SlackImageCompleteError => ({
    code: 'SLACK_IMAGE_COMPLETE_FAILED',
    message: `files.completeUpload failed: ${cause}`,
    ...(slackError !== undefined ? { slackError } : {}),
  }),
  shareFailed: ({ cause, slackError }: { cause: string; slackError?: string }): SlackImageShareError => ({
    code: 'SLACK_IMAGE_SHARE_FAILED',
    message: `files.share failed: ${cause}`,
    ...(slackError !== undefined ? { slackError } : {}),
  }),
} as const;
