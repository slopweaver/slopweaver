/**
 * Tests for the `register_handoff` MCP tool. Exercises the slug
 * derivation, refuse-overwrite default, atomic write, and the read-back
 * round-trip via the configured console dir.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegisterHandoffArgs, RegisterHandoffResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { createRegisterHandoffTool, slugifyAnchor } from './register-handoff.ts';

describe('slugifyAnchor', () => {
  it.each([
    ['PLT-583', 'plt-583'],
    ['#10407', '10407'],
    ['PR #10407 deploy review', 'pr-10407-deploy-review'],
    ['  leading and trailing  ', 'leading-and-trailing'],
    ['UPPERCASE', 'uppercase'],
    ['with___underscores', 'with-underscores'],
    ['unicode 🚀 emoji', 'unicode-emoji'],
  ])('slugifies %s → %s', (input, expected) => {
    expect(slugifyAnchor(input)).toBe(expected);
  });

  it('returns an empty string when the input has no alphanumerics', () => {
    expect(slugifyAnchor('!!!')).toBe('');
  });
});

describe('createRegisterHandoffTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempCwd: string;
  let config: WorkConsoleConfig;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempCwd = mkdtempSync(join(tmpdir(), 'slop-handoff-'));
    config = resolveWorkConsoleConfig({ cwd: tempCwd, consoleRelDir: '.console' });
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('writes a handoff file under handoffs/<slug>.md', async () => {
    const tool = createRegisterHandoffTool({ config });
    const result = await tool.handler({
      input: RegisterHandoffArgs.parse({
        anchor: 'PLT-583',
        title: 'DBM agents follow-up',
        body: 'Working state: PR merged; need to verify deploy.\n',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RegisterHandoffResult.parse(result.value);
      expect(parsed.path.endsWith('/handoffs/plt-583.md')).toBe(true);
      expect(parsed.created).toBe(true);
      expect(parsed.bytes_written).toBeGreaterThan(0);
      const onDisk = readFileSync(parsed.path, 'utf-8');
      expect(onDisk).toContain('# Handoff: DBM agents follow-up');
      expect(onDisk).toContain('PR merged');
    }
  });

  it('refuses to overwrite an existing handoff by default', async () => {
    const tool = createRegisterHandoffTool({ config });
    const args = RegisterHandoffArgs.parse({
      anchor: 'plt-583',
      title: 't1',
      body: 'body 1',
    });
    const first = await tool.handler({ input: args, ctx: { db: dbHandle.db } });
    expect(first.isOk()).toBe(true);

    const second = await tool.handler({ input: args, ctx: { db: dbHandle.db } });
    expect(second.isErr()).toBe(true);
    if (second.isErr()) {
      expect(second.error.message).toContain('already exists');
    }
  });

  it('overwrites when overwrite=true', async () => {
    const tool = createRegisterHandoffTool({ config });
    await tool.handler({
      input: RegisterHandoffArgs.parse({ anchor: 'plt-583', title: 't1', body: 'first' }),
      ctx: { db: dbHandle.db },
    });
    const second = await tool.handler({
      input: RegisterHandoffArgs.parse({ anchor: 'plt-583', title: 't2', body: 'second', overwrite: true }),
      ctx: { db: dbHandle.db },
    });
    expect(second.isOk()).toBe(true);
    if (second.isOk()) {
      const parsed = RegisterHandoffResult.parse(second.value);
      expect(parsed.created).toBe(false);
      const onDisk = readFileSync(parsed.path, 'utf-8');
      expect(onDisk).toContain('second');
      expect(onDisk).not.toContain('first');
    }
  });

  it('errors when the slug collapses to empty', async () => {
    const tool = createRegisterHandoffTool({ config });
    const result = await tool.handler({
      input: RegisterHandoffArgs.parse({ anchor: '!!!', title: 't', body: 'b' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('slugifies to an empty string');
    }
  });
});
