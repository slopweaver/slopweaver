import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFlagsToDirectives, runAddVoiceRule } from './cli-action.ts';

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

describe('parseFlagsToDirectives', () => {
  it('rejects an empty forbid value', () => {
    const r = parseFlagsToDirectives({ flags: { rulesFile: 'x', forbid: [''], replace: [], pattern: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('forbid');
  });

  it('rejects a replace without =>', () => {
    const r = parseFlagsToDirectives({ flags: { rulesFile: 'x', forbid: [], replace: ['foo bar'], pattern: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('=>');
  });

  it('rejects a replace with empty left side', () => {
    const r = parseFlagsToDirectives({
      flags: { rulesFile: 'x', forbid: [], replace: [' => something'], pattern: [] },
    });
    expect(r.ok).toBe(false);
  });

  it('parses one of each kind in stable order', () => {
    const r = parseFlagsToDirectives({
      flags: { rulesFile: 'x', forbid: ['delve'], replace: ['utilize => use'], pattern: ['\\bnotably\\b'] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.directives.map((d) => d.type)).toEqual(['forbid', 'replace', 'pattern']);
      const replace = r.directives[1];
      if (replace?.type === 'replace') {
        expect(replace.from).toBe('utilize');
        expect(replace.to).toBe('use');
      }
    }
  });

  it('trims whitespace around the => separator', () => {
    const r = parseFlagsToDirectives({
      flags: { rulesFile: 'x', forbid: [], replace: ['  utilize   =>   use  '], pattern: [] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const replace = r.directives[0];
      if (replace?.type === 'replace') {
        expect(replace.from).toBe('utilize');
        expect(replace.to).toBe('use');
      }
    }
  });
});

describe('runAddVoiceRule', () => {
  let tempDir: string;
  let rulesFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'slopweaver-voice-rule-'));
    rulesFile = join(tempDir, 'communication-style.md');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exits 2 when no directive flags are given', async () => {
    const { io, readStderr } = makeIo();
    const code = await runAddVoiceRule({
      flags: { rulesFile, forbid: [], replace: [], pattern: [] },
      io,
    });
    expect(code).toBe(2);
    expect(readStderr()).toContain('at least one');
  });

  it('creates the file when missing and writes the first directive', async () => {
    const { io, readStdout } = makeIo();
    const code = await runAddVoiceRule({
      flags: { rulesFile, forbid: ['delve'], replace: [], pattern: [] },
      io,
    });
    expect(code).toBe(0);
    const written = readFileSync(rulesFile, 'utf-8');
    expect(written).toContain('## Hard rules');
    expect(written).toContain('- forbid: delve');
    expect(readStdout()).toContain('ok');
    expect(readStdout()).toContain('added=1');
  });

  it('appends to an existing rules file and reports added/skipped counts', async () => {
    writeFileSync(rulesFile, '## Hard rules\n\n- forbid: delve\n', 'utf-8');
    const { io, readStdout } = makeIo();
    const code = await runAddVoiceRule({
      flags: { rulesFile, forbid: ['delve', 'notably'], replace: [], pattern: [] },
      io,
    });
    expect(code).toBe(0);
    expect(readStdout()).toContain('added=1');
    expect(readStdout()).toContain('skipped=1');
    expect(readFileSync(rulesFile, 'utf-8')).toContain('- forbid: notably');
  });

  it('returns 0 with stderr note when every directive is a duplicate', async () => {
    writeFileSync(rulesFile, '## Hard rules\n\n- forbid: delve\n', 'utf-8');
    const { io, readStderr, readStdout } = makeIo();
    const code = await runAddVoiceRule({
      flags: { rulesFile, forbid: ['delve'], replace: [], pattern: [] },
      io,
    });
    expect(code).toBe(0);
    expect(readStderr()).toContain('already present');
    expect(readStdout()).toBe('');
  });
});
