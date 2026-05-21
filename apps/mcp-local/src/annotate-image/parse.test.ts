import { describe, expect, it } from 'vitest';
import { parseAnnotationSpec, parseAnnotationSpecFromJson } from './parse.ts';

describe('parseAnnotationSpec', () => {
  it('rejects non-objects', () => {
    const r = parseAnnotationSpec(42);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('ANNOTATE_SPEC_INVALID');
  });

  it('rejects missing shapes', () => {
    const r = parseAnnotationSpec({});
    expect(r.isErr()).toBe(true);
  });

  it('rejects empty shapes array', () => {
    const r = parseAnnotationSpec({ shapes: [] });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('must not be empty');
  });

  it('parses a minimal rect spec', () => {
    const r = parseAnnotationSpec({
      shapes: [{ type: 'rect', x: 10, y: 20, width: 100, height: 50 }],
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.shapes).toHaveLength(1);
      const shape = r.value.shapes[0];
      expect(shape?.type).toBe('rect');
      if (shape?.type === 'rect') {
        expect(shape.x).toBe(10);
        expect(shape.y).toBe(20);
        expect(shape.width).toBe(100);
        expect(shape.height).toBe(50);
        expect(shape.color).toBeUndefined();
      }
    }
  });

  it('rejects rect with non-positive width', () => {
    const r = parseAnnotationSpec({
      shapes: [{ type: 'rect', x: 0, y: 0, width: 0, height: 50 }],
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('rect');
  });

  it('rejects rect with negative x', () => {
    const r = parseAnnotationSpec({
      shapes: [{ type: 'rect', x: -1, y: 0, width: 10, height: 10 }],
    });
    expect(r.isErr()).toBe(true);
  });

  it('parses arrow with explicit head length and color', () => {
    const r = parseAnnotationSpec({
      shapes: [{ type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 100, color: '#00f', headLength: 20 }],
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const shape = r.value.shapes[0];
      if (shape?.type === 'arrow') {
        expect(shape.color).toBe('#00f');
        expect(shape.headLength).toBe(20);
      }
    }
  });

  it('parses text with background pill', () => {
    const r = parseAnnotationSpec({
      shapes: [{ type: 'text', x: 50, y: 60, text: 'hello', background: '#fff' }],
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const shape = r.value.shapes[0];
      if (shape?.type === 'text') {
        expect(shape.text).toBe('hello');
        expect(shape.background).toBe('#fff');
      }
    }
  });

  it('rejects text with empty content', () => {
    const r = parseAnnotationSpec({ shapes: [{ type: 'text', x: 0, y: 0, text: '' }] });
    expect(r.isErr()).toBe(true);
  });

  it('rejects an unknown shape type with the failing index', () => {
    const r = parseAnnotationSpec({
      shapes: [
        { type: 'rect', x: 0, y: 0, width: 1, height: 1 },
        { type: 'circle', x: 0, y: 0, r: 5 },
      ],
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.message).toContain('shapes[1]');
      expect(r.error.message).toContain('unknown type');
    }
  });

  it('parses a multi-shape spec preserving order', () => {
    const r = parseAnnotationSpec({
      shapes: [
        { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
        { type: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5 },
        { type: 'text', x: 1, y: 1, text: 'A' },
      ],
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.shapes.map((s) => s.type)).toEqual(['rect', 'arrow', 'text']);
    }
  });
});

describe('parseAnnotationSpecFromJson', () => {
  it('wraps a JSON.parse failure as ANNOTATE_SPEC_INVALID', () => {
    const r = parseAnnotationSpecFromJson('{not json');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('ANNOTATE_SPEC_INVALID');
      expect(r.error.message).toContain('JSON parse failed');
    }
  });

  it('round-trips a valid JSON spec', () => {
    const r = parseAnnotationSpecFromJson(
      JSON.stringify({ shapes: [{ type: 'rect', x: 1, y: 2, width: 3, height: 4 }] }),
    );
    expect(r.isOk()).toBe(true);
  });
});
