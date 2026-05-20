import { describe, expect, it, vi } from 'vitest';
import { renderWalkQueue, runWalk } from './index.ts';
import { parseWalkOrder } from './parse-walk-order.ts';

describe('renderWalkQueue', () => {
  it('renders the empty-queue helper text', () => {
    const out = renderWalkQueue([]);
    expect(out).toContain('No items in the walk queue.');
    expect(out).toContain('/reconcile');
  });

  it('renders a multi-line numbered list', () => {
    const items = parseWalkOrder(
      [
        '## Walk order',
        '',
        '1. **[PR-1](https://x/1)** — `[priority-0-LIVE]` — chase reviewer. *(reconciliation/inbox)*',
      ].join('\n'),
    );
    const out = renderWalkQueue(items);
    expect(out).toContain('Walking 1 item(s)');
    expect(out).toContain('[PR-1]');
    expect(out).toContain('priority-0-LIVE');
    expect(out).toContain('https://x/1');
    expect(out).toContain('(reconciliation/inbox)');
  });
});

describe('runWalk', () => {
  it('prints the queue when the reconciliation file exists', async () => {
    const stdout = { write: vi.fn() };
    const code = await runWalk({
      cwd: '/tmp/repo',
      readFile: async () => '## Walk order\n\n1. test item',
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
});
