import { describe, expect, it, vi } from 'vitest';
import { renderWalkQueue, runWalk } from './index.ts';
import { type WalkItem, parseWalkOrder } from './parse-walk-order.ts';

function makeItem({ id, anchor, description }: { id: string; anchor: string; description: string }): WalkItem {
  return {
    id,
    anchor,
    anchor_url: `https://example.com/${anchor}`,
    priority: null,
    description,
    source_bucket: null,
  };
}

describe('renderWalkQueue', () => {
  it('renders the empty-queue helper text', () => {
    const out = renderWalkQueue([]);
    expect(out).toContain('No items in the walk queue.');
    expect(out).toContain('/reconcile');
  });

  it('renders a multi-line numbered list', () => {
    const result = parseWalkOrder(
      [
        '## Walk order',
        '',
        '1. **[PR-1](https://x/1)** — `[priority-0-LIVE]` — chase reviewer. *(reconciliation/inbox)*',
      ].join('\n'),
    );
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const out = renderWalkQueue(result.value.items);
    expect(out).toContain('Walking 1 item(s)');
    expect(out).toContain('[PR-1]');
    expect(out).toContain('priority-0-LIVE');
    expect(out).toContain('https://x/1');
    expect(out).toContain('(reconciliation/inbox)');
  });

  it('renders exact 1-digit numbering for a queue of ≤9 items', () => {
    const items: WalkItem[] = [
      makeItem({ id: 'aaaaaaaa', anchor: 'A', description: 'first' }),
      makeItem({ id: 'bbbbbbbb', anchor: 'B', description: 'second' }),
      makeItem({ id: 'cccccccc', anchor: 'C', description: 'third' }),
    ];
    const out = renderWalkQueue(items);
    expect(out).toBe(
      [
        'slopweaver walk',
        '',
        'Walking 3 item(s). Per-item actions in /lock-in:',
        '  do | agent | handoff | defer | skip | note | open-question | jump N',
        '',
        '(Interactive loop ships in a follow-up PR — for now this is read-only.)',
        '',
        '1. [A] first',
        '    https://example.com/A',
        '2. [B] second',
        '    https://example.com/B',
        '3. [C] third',
        '    https://example.com/C',
        '',
      ].join('\n'),
    );
  });

  it('renders exact 2-digit padding for a queue of 10+ items', () => {
    const items: WalkItem[] = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `id${i + 1}`.padStart(8, '0'), anchor: `A${i + 1}`, description: `item ${i + 1}` }),
    );
    const out = renderWalkQueue(items);
    const expected = [
      'slopweaver walk',
      '',
      'Walking 10 item(s). Per-item actions in /lock-in:',
      '  do | agent | handoff | defer | skip | note | open-question | jump N',
      '',
      '(Interactive loop ships in a follow-up PR — for now this is read-only.)',
      '',
      ' 1. [A1] item 1',
      '    https://example.com/A1',
      ' 2. [A2] item 2',
      '    https://example.com/A2',
      ' 3. [A3] item 3',
      '    https://example.com/A3',
      ' 4. [A4] item 4',
      '    https://example.com/A4',
      ' 5. [A5] item 5',
      '    https://example.com/A5',
      ' 6. [A6] item 6',
      '    https://example.com/A6',
      ' 7. [A7] item 7',
      '    https://example.com/A7',
      ' 8. [A8] item 8',
      '    https://example.com/A8',
      ' 9. [A9] item 9',
      '    https://example.com/A9',
      '10. [A10] item 10',
      '    https://example.com/A10',
      '',
    ].join('\n');
    expect(out).toBe(expected);
  });
});

describe('runWalk', () => {
  it('prints the queue when the reconciliation file exists', async () => {
    const stdout = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () => '## Walk order\n\n1. **[X](https://x/)** test item',
      stdout,
    });
    expect(code).toBe(0);
    expect(stdout.write).toHaveBeenCalledOnce();
    const payload = stdout.write.mock.calls[0]?.[0] ?? '';
    expect(payload).toContain('test item');
  });

  it('prints the empty-state helper when the file is missing', async () => {
    const stdout = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      stdout,
    });
    expect(code).toBe(0);
    const payload = stdout.write.mock.calls[0]?.[0] ?? '';
    expect(payload).toContain('No items');
  });

  it('returns non-zero on unexpected read failures', async () => {
    const stdout = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () => {
        throw new Error('permission denied');
      },
      stdout,
    });
    expect(code).toBe(1);
    const payload = stdout.write.mock.calls[0]?.[0] ?? '';
    expect(payload).toContain('failed to read');
  });

  it('returns non-zero and prints the parse-error message on duplicate items', async () => {
    const stdout = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () =>
        ['## Walk order', '', '1. **[X](https://x/1)** first', '2. **[X](https://x/1)** dup'].join('\n'),
      stdout,
    });
    expect(code).toBe(1);
    const payload = stdout.write.mock.calls[0]?.[0] ?? '';
    expect(payload).toContain('duplicate');
  });

  it('forwards parse warnings to stderr while still printing the queue', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () =>
        ['## Walk order', '', '1. ', '2. **[X](https://x/)** real item', '3. **[Y](https://y/)**'].join('\n'),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const stdoutPayload = stdout.write.mock.calls[0]?.[0] ?? '';
    expect(stdoutPayload).toContain('real item');
    // Two malformed numbered rows (the bare `1.` and the anchor-only
    // `3. **[Y](https://y/)**`) each produce a warning.
    expect(stderr.write).toHaveBeenCalledTimes(2);
    const warnings = stderr.write.mock.calls.map((call) => call[0]);
    expect(warnings[0]).toContain('line 3');
    expect(warnings[0]).toContain('no description after stripping metadata');
    expect(warnings[1]).toContain('line 5');
  });

  it('does not emit anything to stderr when there are no warnings', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () => '## Walk order\n\n1. **[X](https://x/)** clean item',
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
