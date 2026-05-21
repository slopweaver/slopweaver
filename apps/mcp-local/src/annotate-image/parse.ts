/**
 * Pure parsing of an untrusted JSON annotation spec into the typed
 * `AnnotationSpec` shape. Validates structure + numeric ranges. Never
 * touches the filesystem.
 */

import { err, ok, type Result } from '@slopweaver/errors';
import { AnnotateImageErrors, type AnnotateImageError } from './errors.ts';
import type { AnnotationShape, AnnotationSpec } from './types.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseShape(raw: unknown, index: number): Result<AnnotationShape, AnnotateImageError> {
  if (!isObject(raw)) {
    return err(AnnotateImageErrors.specInvalid({ reason: `shapes[${index}] is not an object` }));
  }
  const type = raw['type'];
  if (type === 'rect') {
    const x = asNonNegativeNumber(raw['x']);
    const y = asNonNegativeNumber(raw['y']);
    const width = asPositiveNumber(raw['width']);
    const height = asPositiveNumber(raw['height']);
    if (x === null || y === null || width === null || height === null) {
      return err(
        AnnotateImageErrors.specInvalid({
          reason: `shapes[${index}] rect requires non-negative x,y and positive width,height`,
        }),
      );
    }
    const color = asString(raw['color']);
    const strokeWidth = asPositiveNumber(raw['strokeWidth']);
    return ok({
      type: 'rect',
      x,
      y,
      width,
      height,
      ...(color !== null ? { color } : {}),
      ...(strokeWidth !== null ? { strokeWidth } : {}),
    });
  }
  if (type === 'arrow') {
    const x1 = asNonNegativeNumber(raw['x1']);
    const y1 = asNonNegativeNumber(raw['y1']);
    const x2 = asNonNegativeNumber(raw['x2']);
    const y2 = asNonNegativeNumber(raw['y2']);
    if (x1 === null || y1 === null || x2 === null || y2 === null) {
      return err(
        AnnotateImageErrors.specInvalid({
          reason: `shapes[${index}] arrow requires non-negative x1,y1,x2,y2`,
        }),
      );
    }
    const color = asString(raw['color']);
    const strokeWidth = asPositiveNumber(raw['strokeWidth']);
    const headLength = asPositiveNumber(raw['headLength']);
    return ok({
      type: 'arrow',
      x1,
      y1,
      x2,
      y2,
      ...(color !== null ? { color } : {}),
      ...(strokeWidth !== null ? { strokeWidth } : {}),
      ...(headLength !== null ? { headLength } : {}),
    });
  }
  if (type === 'text') {
    const x = asNonNegativeNumber(raw['x']);
    const y = asNonNegativeNumber(raw['y']);
    const text = asString(raw['text']);
    if (x === null || y === null || text === null || text.length === 0) {
      return err(
        AnnotateImageErrors.specInvalid({
          reason: `shapes[${index}] text requires non-negative x,y and non-empty text`,
        }),
      );
    }
    const color = asString(raw['color']);
    const fontSize = asPositiveNumber(raw['fontSize']);
    const background = asString(raw['background']);
    return ok({
      type: 'text',
      x,
      y,
      text,
      ...(color !== null ? { color } : {}),
      ...(fontSize !== null ? { fontSize } : {}),
      ...(background !== null ? { background } : {}),
    });
  }
  return err(AnnotateImageErrors.specInvalid({ reason: `shapes[${index}] has unknown type ${JSON.stringify(type)}` }));
}

/**
 * Parse a raw value (typically the output of `JSON.parse`) into a
 * validated `AnnotationSpec`. Returns the first error encountered.
 */
export function parseAnnotationSpec(raw: unknown): Result<AnnotationSpec, AnnotateImageError> {
  if (!isObject(raw)) {
    return err(AnnotateImageErrors.specInvalid({ reason: 'spec must be an object' }));
  }
  const shapesRaw = raw['shapes'];
  if (!Array.isArray(shapesRaw)) {
    return err(AnnotateImageErrors.specInvalid({ reason: 'spec.shapes must be an array' }));
  }
  if (shapesRaw.length === 0) {
    return err(AnnotateImageErrors.specInvalid({ reason: 'spec.shapes must not be empty' }));
  }
  const shapes: AnnotationShape[] = [];
  for (let i = 0; i < shapesRaw.length; i++) {
    const parsed = parseShape(shapesRaw[i], i);
    if (parsed.isErr()) {
      return err(parsed.error);
    }
    shapes.push(parsed.value);
  }
  return ok({ shapes });
}

/**
 * Parse a JSON string into a validated `AnnotationSpec`. Wraps
 * `parseAnnotationSpec` with a `JSON.parse` failure-mode error.
 */
export function parseAnnotationSpecFromJson(text: string): Result<AnnotationSpec, AnnotateImageError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err(
      AnnotateImageErrors.specInvalid({
        reason: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
    );
  }
  return parseAnnotationSpec(raw);
}
