import { describe, expect, it } from 'vitest';
import { parseWalkOrder } from './parse-walk-order.ts';

describe('parseWalkOrder', () => {
  it('returns empty when the section is absent', () => {
    const md = '# Reconciliation\n\nSome other content.';
    expect(parseWalkOrder(md)).toEqual([]);
  });

  it('parses a fully-formed item line', () => {
    const md = [
      '## Walk order (priority-ranked)',
      '',
      '1. **[PR-123](https://example.com/123)** — `[priority-2]` — reply to thread. *(reconciliation/inbox)*',
    ].join('\n');
    const items = parseWalkOrder(md);
    expect(items.length).toBe(1);
    expect(items[0]).toEqual({
      index: 1,
      anchor: 'PR-123',
      anchor_url: 'https://example.com/123',
      priority: 'priority-2',
      description: 'reply to thread.',
      source_bucket: 'reconciliation/inbox',
    });
  });

  it('parses an item without priority or source bucket', () => {
    const md = ['## Walk order', '', '1. **[X](https://x/)** — needs a poke.'].join('\n');
    const items = parseWalkOrder(md);
    expect(items[0]?.priority).toBe(null);
    expect(items[0]?.source_bucket).toBe(null);
    expect(items[0]?.description).toBe('needs a poke.');
  });

  it('numbers items sequentially regardless of source numbering', () => {
    const md = ['## Walk order', '', '1. one', '2. two', '7. seven (renumbered)'].join('\n');
    const items = parseWalkOrder(md);
    expect(items.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.description)).toEqual(['one', 'two', 'seven (renumbered)']);
  });

  it('stops at the next ## heading', () => {
    const md = ['## Walk order', '', '1. one', '', '## Apply these', '', '1. should be ignored'].join('\n');
    const items = parseWalkOrder(md);
    expect(items.length).toBe(1);
  });

  it('ignores non-numbered lines inside the section', () => {
    const md = ['## Walk order', '', '> Single flat list across all buckets.', '', '1. real item'].join('\n');
    const items = parseWalkOrder(md);
    expect(items.length).toBe(1);
  });
});
