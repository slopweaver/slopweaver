/**
 * Reads an input image, composites the annotation SVG overlay on top
 * via sharp, and writes a PNG to `outputPath`. The output is always
 * PNG regardless of input format so callers don't have to think about
 * JPEG quality loss when re-encoding.
 *
 * The sharp dependency is hidden behind a small `ImageCompositor` seam
 * so unit tests can stub the native binary out completely; the default
 * implementation simply wires sharp through.
 */

import sharp from 'sharp';
import { errAsync, okAsync, ResultAsync } from '@slopweaver/errors';
import { AnnotateImageErrors, type AnnotateImageError } from './errors.ts';
import { renderSvgOverlay } from './render-svg.ts';
import type { AnnotateImageArgs } from './types.ts';

/**
 * Minimal compositor interface. The default implementation drives
 * sharp; tests substitute a stub. The interface deliberately exposes
 * the two steps the annotator needs (`readDimensions` and
 * `compositeAndWritePng`) rather than re-exposing sharp's full surface.
 */
export type ImageCompositor = {
  /** Read the source image's intrinsic pixel dimensions. */
  readDimensions: (input: { inputPath: string }) => Promise<{ width: number; height: number } | null>;
  /** Composite an SVG overlay onto the source and write a PNG. */
  compositeAndWritePng: (input: { inputPath: string; outputPath: string; overlaySvg: Buffer }) => Promise<void>;
};

export type AnnotateImageDeps = {
  readonly compositor?: ImageCompositor;
};

/**
 * Default sharp-backed compositor. Exported so callers that want to
 * compose their own deps can still re-use it.
 */
export const defaultCompositor: ImageCompositor = {
  readDimensions: async ({ inputPath }) => {
    const meta = await sharp(inputPath).metadata();
    if (typeof meta.width !== 'number' || typeof meta.height !== 'number') return null;
    return { width: meta.width, height: meta.height };
  },
  compositeAndWritePng: async ({ inputPath, outputPath, overlaySvg }) => {
    await sharp(inputPath)
      .composite([{ input: overlaySvg }])
      .png()
      .toFile(outputPath);
  },
};

export function annotateImage(
  args: AnnotateImageArgs,
  deps: AnnotateImageDeps = {},
): ResultAsync<{ width: number; height: number }, AnnotateImageError> {
  const compositor = deps.compositor ?? defaultCompositor;
  return ResultAsync.fromPromise(compositor.readDimensions({ inputPath: args.inputPath }), (e) =>
    AnnotateImageErrors.imageReadFailed({
      inputPath: args.inputPath,
      cause: e instanceof Error ? e.message : String(e),
    }),
  ).andThen((dims) => {
    if (dims === null) {
      return errAsync<{ width: number; height: number }, AnnotateImageError>(
        AnnotateImageErrors.renderFailed({ cause: 'compositor could not determine input dimensions' }),
      );
    }
    const svg = renderSvgOverlay({ spec: args.spec, width: dims.width, height: dims.height });
    const overlay = Buffer.from(svg, 'utf-8');
    return ResultAsync.fromPromise(
      compositor.compositeAndWritePng({ inputPath: args.inputPath, outputPath: args.outputPath, overlaySvg: overlay }),
      (e) =>
        AnnotateImageErrors.imageWriteFailed({
          outputPath: args.outputPath,
          cause: e instanceof Error ? e.message : String(e),
        }),
    ).andThen(() => okAsync<{ width: number; height: number }, AnnotateImageError>(dims));
  });
}
