import type { BaseError } from '@slopweaver/errors';

export interface AnnotateSpecInvalidError extends BaseError {
  readonly code: 'ANNOTATE_SPEC_INVALID';
  readonly reason: string;
}

export interface AnnotateImageReadError extends BaseError {
  readonly code: 'ANNOTATE_IMAGE_READ_FAILED';
  readonly inputPath: string;
}

export interface AnnotateImageWriteError extends BaseError {
  readonly code: 'ANNOTATE_IMAGE_WRITE_FAILED';
  readonly outputPath: string;
}

export interface AnnotateImageRenderError extends BaseError {
  readonly code: 'ANNOTATE_IMAGE_RENDER_FAILED';
}

export type AnnotateImageError =
  | AnnotateSpecInvalidError
  | AnnotateImageReadError
  | AnnotateImageWriteError
  | AnnotateImageRenderError;

export const AnnotateImageErrors = {
  specInvalid: ({ reason }: { reason: string }): AnnotateSpecInvalidError => ({
    code: 'ANNOTATE_SPEC_INVALID',
    message: `annotation spec invalid: ${reason}`,
    reason,
  }),
  imageReadFailed: ({ inputPath, cause }: { inputPath: string; cause: string }): AnnotateImageReadError => ({
    code: 'ANNOTATE_IMAGE_READ_FAILED',
    message: `failed to read input image at ${inputPath}: ${cause}`,
    inputPath,
  }),
  imageWriteFailed: ({ outputPath, cause }: { outputPath: string; cause: string }): AnnotateImageWriteError => ({
    code: 'ANNOTATE_IMAGE_WRITE_FAILED',
    message: `failed to write annotated image at ${outputPath}: ${cause}`,
    outputPath,
  }),
  renderFailed: ({ cause }: { cause: string }): AnnotateImageRenderError => ({
    code: 'ANNOTATE_IMAGE_RENDER_FAILED',
    message: `render failed: ${cause}`,
  }),
} as const;
