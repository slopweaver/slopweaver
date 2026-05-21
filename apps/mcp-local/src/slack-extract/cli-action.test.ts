import { describe, expect, it } from 'vitest';
import { runSlackExtractXoxc } from './cli-action.ts';

function makeIo(stdinContents: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => stdout.push(s) },
      stderr: { write: (s: string) => stderr.push(s) },
      readStdin: async () => stdinContents,
    },
    readStdout: () => stdout.join(''),
    readStderr: () => stderr.join(''),
  };
}

describe('runSlackExtractXoxc', () => {
  it('returns 1 + stderr line when stdin is empty', async () => {
    const { io, readStderr } = makeIo('');
    const code = await runSlackExtractXoxc({ flags: { format: 'token' }, io });
    expect(code).toBe(1);
    expect(readStderr()).toContain('no xoxc token');
  });

  it('returns 1 when stdin has no token', async () => {
    const { io } = makeIo('nothing to see');
    const code = await runSlackExtractXoxc({ flags: { format: 'token' }, io });
    expect(code).toBe(1);
  });

  it('prints the bare token + newline on default format', async () => {
    const { io, readStdout } = makeIo('xoxc-aaaa-1111\n');
    const code = await runSlackExtractXoxc({ flags: { format: 'token' }, io });
    expect(code).toBe(0);
    expect(readStdout()).toBe('xoxc-aaaa-1111\n');
  });

  it('prints an export line on --format export', async () => {
    const { io, readStdout } = makeIo('xoxc-aaaa-1111');
    const code = await runSlackExtractXoxc({ flags: { format: 'export' }, io });
    expect(code).toBe(0);
    expect(readStdout()).toBe('export SLACK_XOXC=xoxc-aaaa-1111\n');
  });

  it('parses a JSON dump (object) and finds the embedded token', async () => {
    const dump = JSON.stringify({
      localConfig_v2: JSON.stringify({ teams: { T1: { token: 'xoxc-bbbb-2222' } } }),
    });
    const { io, readStdout } = makeIo(dump);
    const code = await runSlackExtractXoxc({ flags: { format: 'token' }, io });
    expect(code).toBe(0);
    expect(readStdout()).toBe('xoxc-bbbb-2222\n');
  });

  it('falls back to a raw text scan when stdin is not valid JSON', async () => {
    // Looks JSON-ish (starts with `{`) but isn't valid. Should still
    // catch the embedded token via the raw fallback.
    const { io, readStdout } = makeIo('{not json but contains xoxc-cccc-3333');
    const code = await runSlackExtractXoxc({ flags: { format: 'token' }, io });
    expect(code).toBe(0);
    expect(readStdout()).toBe('xoxc-cccc-3333\n');
  });
});
