/**
 * Pure SVG renderer for an `AnnotationSpec`. Returns the SVG markup
 * sized to the source image's intrinsic dimensions. The output is
 * composited over the source by `annotate.ts` via sharp; this module
 * never touches the filesystem.
 */

import type { AnnotationArrow, AnnotationRect, AnnotationShape, AnnotationSpec, AnnotationText } from './types.ts';

const DEFAULT_COLOR = '#ef4444';
const DEFAULT_STROKE_WIDTH = 4;
const DEFAULT_FONT_SIZE = 24;
const DEFAULT_ARROW_HEAD_LENGTH = 16;
const DEFAULT_ARROW_HEAD_ANGLE_DEG = 28;

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderRect(shape: AnnotationRect): string {
  const color = escapeXml(shape.color ?? DEFAULT_COLOR);
  const strokeWidth = shape.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  return (
    `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ` +
    `fill="none" stroke="${color}" stroke-width="${strokeWidth}" />`
  );
}

function renderArrow(shape: AnnotationArrow): string {
  const color = escapeXml(shape.color ?? DEFAULT_COLOR);
  const strokeWidth = shape.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const headLength = shape.headLength ?? DEFAULT_ARROW_HEAD_LENGTH;
  const dx = shape.x2 - shape.x1;
  const dy = shape.y2 - shape.y1;
  const angle = Math.atan2(dy, dx);
  const headAngleRad = (DEFAULT_ARROW_HEAD_ANGLE_DEG * Math.PI) / 180;
  // Two side points making a triangle with the arrow head at (x2,y2).
  const sideAx = shape.x2 - headLength * Math.cos(angle - headAngleRad);
  const sideAy = shape.y2 - headLength * Math.sin(angle - headAngleRad);
  const sideBx = shape.x2 - headLength * Math.cos(angle + headAngleRad);
  const sideBy = shape.y2 - headLength * Math.sin(angle + headAngleRad);
  return (
    `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" ` +
    `stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />` +
    `<polygon points="${shape.x2},${shape.y2} ${sideAx.toFixed(2)},${sideAy.toFixed(2)} ${sideBx.toFixed(
      2,
    )},${sideBy.toFixed(2)}" fill="${color}" />`
  );
}

function renderText(shape: AnnotationText): string {
  const color = escapeXml(shape.color ?? DEFAULT_COLOR);
  const fontSize = shape.fontSize ?? DEFAULT_FONT_SIZE;
  const text = escapeXml(shape.text);
  const fontStack = `'-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif'`;
  // dominant-baseline + the empirical width estimate keep the pill
  // tight around the text without bringing in a layout engine.
  const baselineDy = fontSize * 0.85;
  const padding = Math.max(4, Math.round(fontSize * 0.25));
  if (shape.background !== undefined) {
    const bg = escapeXml(shape.background);
    // Rough text-width estimate: 0.55em per char, sans-serif. Good
    // enough for short labels (the only thing this shape supports
    // well).
    const textWidth = Math.ceil(shape.text.length * fontSize * 0.55);
    const boxHeight = fontSize + padding * 2;
    return (
      `<rect x="${shape.x - padding}" y="${shape.y}" width="${textWidth + padding * 2}" height="${boxHeight}" ` +
      `fill="${bg}" rx="${Math.round(padding / 2)}" />` +
      `<text x="${shape.x}" y="${shape.y + padding + baselineDy}" font-family=${fontStack} ` +
      `font-size="${fontSize}" font-weight="600" fill="${color}">${text}</text>`
    );
  }
  return (
    `<text x="${shape.x}" y="${shape.y + baselineDy}" font-family=${fontStack} ` +
    `font-size="${fontSize}" font-weight="600" fill="${color}">${text}</text>`
  );
}

function renderShape(shape: AnnotationShape): string {
  switch (shape.type) {
    case 'rect':
      return renderRect(shape);
    case 'arrow':
      return renderArrow(shape);
    case 'text':
      return renderText(shape);
  }
}

/**
 * Render the spec's shapes as an SVG document sized to `width`/`height`
 * (which must match the source image's intrinsic pixel dimensions for
 * the overlay to register correctly).
 */
export function renderSvgOverlay({
  spec,
  width,
  height,
}: {
  spec: AnnotationSpec;
  width: number;
  height: number;
}): string {
  const body = spec.shapes.map(renderShape).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${body}</svg>`
  );
}
