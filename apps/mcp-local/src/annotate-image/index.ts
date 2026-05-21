export { parseAnnotationSpec, parseAnnotationSpecFromJson } from './parse.ts';
export { renderSvgOverlay } from './render-svg.ts';
export { annotateImage, defaultCompositor, type AnnotateImageDeps, type ImageCompositor } from './annotate.ts';
export { AnnotateImageErrors, type AnnotateImageError } from './errors.ts';
export type {
  AnnotateImageArgs,
  AnnotationArrow,
  AnnotationRect,
  AnnotationShape,
  AnnotationSpec,
  AnnotationText,
} from './types.ts';
