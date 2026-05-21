import { describe, expect, it, vi } from 'vitest';
import { runAnnotateImage } from './cli-action.ts';

vi.mock('./annotate.ts', () => ({
  annotateImage: vi.fn(async () => {
    const { ok } = await import('@slopweaver/errors');
    return ok({ width: 800, height: 600 });
  }),
}));

function makeIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => stdout.push(s) },
      stderr: { write: (s: string) => stderr.push(s) },
    },
    readStdout: () => stdout.join(''),
    readStderr: () => stderr.join(''),
  };
}

describe('runAnnotateImage', () => {
  it('errors when neither --spec-json nor --spec-file is set', async () => {
    const { io, readStderr } = makeIo();
    const code = await runAnnotateImage({
      flags: { input: '/tmp/in.png', output: '/tmp/out.png' },
      io,
    });
    expect(code).toBe(2);
    expect(readStderr()).toContain('--spec-json');
  });

  it('errors when --spec-json is malformed JSON', async () => {
    const { io, readStderr } = makeIo();
    const code = await runAnnotateImage({
      flags: { input: '/tmp/in.png', output: '/tmp/out.png', specJson: '{not json' },
      io,
    });
    expect(code).toBe(2);
    expect(readStderr()).toContain('JSON parse');
  });

  it('errors when the parsed spec is structurally invalid', async () => {
    const { io, readStderr } = makeIo();
    const code = await runAnnotateImage({
      flags: { input: '/tmp/in.png', output: '/tmp/out.png', specJson: JSON.stringify({ shapes: [] }) },
      io,
    });
    expect(code).toBe(2);
    expect(readStderr()).toContain('shapes');
  });

  it('returns 0 + prints dims on success', async () => {
    const { io, readStdout } = makeIo();
    const code = await runAnnotateImage({
      flags: {
        input: '/tmp/in.png',
        output: '/tmp/out.png',
        specJson: JSON.stringify({ shapes: [{ type: 'rect', x: 0, y: 0, width: 10, height: 10 }] }),
      },
      io,
    });
    expect(code).toBe(0);
    expect(readStdout()).toContain('ok');
    expect(readStdout()).toContain('800x600');
  });
});
