/**
 * Unit tests for `annotateImage` using an injected compositor stub.
 * We do not load the real native sharp binary here; the test pins the
 * composite-call shape (the SVG overlay reaches the compositor as a
 * buffer) without exercising libvips. Round-trip against real sharp
 * is exercised by the smoke test.
 */

import { describe, expect, it } from 'vitest';
import { annotateImage, type ImageCompositor } from './annotate.ts';

function makeCompositorStub({ dims }: { dims: { width: number; height: number } | null }): {
  compositor: ImageCompositor;
  overlays: Buffer[];
  writes: string[];
} {
  const overlays: Buffer[] = [];
  const writes: string[] = [];
  const compositor: ImageCompositor = {
    readDimensions: async () => dims,
    compositeAndWritePng: async ({ outputPath, overlaySvg }) => {
      overlays.push(overlaySvg);
      writes.push(outputPath);
    },
  };
  return { compositor, overlays, writes };
}

describe('annotateImage', () => {
  it('returns the source dimensions on success and writes to outputPath', async () => {
    const { compositor, overlays, writes } = makeCompositorStub({ dims: { width: 800, height: 600 } });
    const result = await annotateImage(
      {
        inputPath: '/tmp/in.png',
        outputPath: '/tmp/out.png',
        spec: { shapes: [{ type: 'rect', x: 10, y: 10, width: 100, height: 100 }] },
      },
      { compositor },
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.width).toBe(800);
      expect(result.value.height).toBe(600);
    }
    expect(writes).toEqual(['/tmp/out.png']);
    expect(overlays).toHaveLength(1);
    const svgText = overlays[0]?.toString('utf-8') ?? '';
    expect(svgText).toContain('width="800"');
    expect(svgText).toContain('<rect ');
  });

  it('fails with ANNOTATE_IMAGE_READ_FAILED when readDimensions throws', async () => {
    const compositor: ImageCompositor = {
      readDimensions: () => Promise.reject(new Error('input not found')),
      compositeAndWritePng: async () => {
        // not reachable
      },
    };
    const result = await annotateImage(
      {
        inputPath: '/tmp/missing.png',
        outputPath: '/tmp/out.png',
        spec: { shapes: [{ type: 'rect', x: 0, y: 0, width: 1, height: 1 }] },
      },
      { compositor },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ANNOTATE_IMAGE_READ_FAILED');
      if (result.error.code === 'ANNOTATE_IMAGE_READ_FAILED') {
        expect(result.error.inputPath).toBe('/tmp/missing.png');
      }
    }
  });

  it('fails with ANNOTATE_IMAGE_RENDER_FAILED when the compositor returns null dimensions', async () => {
    const { compositor } = makeCompositorStub({ dims: null });
    const result = await annotateImage(
      {
        inputPath: '/tmp/in.png',
        outputPath: '/tmp/out.png',
        spec: { shapes: [{ type: 'rect', x: 0, y: 0, width: 1, height: 1 }] },
      },
      { compositor },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ANNOTATE_IMAGE_RENDER_FAILED');
    }
  });

  it('fails with ANNOTATE_IMAGE_WRITE_FAILED when compositeAndWritePng rejects', async () => {
    const compositor: ImageCompositor = {
      readDimensions: async () => ({ width: 100, height: 100 }),
      compositeAndWritePng: () => Promise.reject(new Error('EACCES: permission denied')),
    };
    const result = await annotateImage(
      {
        inputPath: '/tmp/in.png',
        outputPath: '/root/protected.png',
        spec: { shapes: [{ type: 'rect', x: 0, y: 0, width: 1, height: 1 }] },
      },
      { compositor },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'ANNOTATE_IMAGE_WRITE_FAILED') {
      expect(result.error.outputPath).toBe('/root/protected.png');
    }
  });
});
