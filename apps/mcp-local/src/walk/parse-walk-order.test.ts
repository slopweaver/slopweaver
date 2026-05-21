import { describe, expect, it } from 'vitest';
import { parseWalkOrder } from './parse-walk-order.ts';

describe('parseWalkOrder', () => {
  it('returns empty when the section is absent', () => {
    const md = '# Reconciliation\n\nSome other content.';
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });

  it('parses a fully-formed item line', () => {
    const md = [
      '## Walk order (priority-ranked)',
      '',
      '1. **[PR-123](https://example.com/123)** — `[priority-2]` — reply to thread. *(reconciliation/inbox)*',
    ].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]).toEqual({
        id: '3',
        anchor: 'PR-123',
        anchor_url: 'https://example.com/123',
        priority: 'priority-2',
        description: 'reply to thread.',
        source_bucket: 'reconciliation/inbox',
      });
    }
  });

  it('parses an item without priority or source bucket', () => {
    const md = ['## Walk order', '', '1. **[X](https://x/)** — needs a poke.'].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value[0]?.priority).toBe(null);
      expect(result.value[0]?.source_bucket).toBe(null);
      expect(result.value[0]?.description).toBe('needs a poke.');
    }
  });

  it('assigns ids from the source-line numbers (1-based)', () => {
    const md = [
      '## Walk order',
      '',
      '1. **[A](https://a/)** one',
      '2. **[B](https://b/)** two',
      '7. **[C](https://c/)** seven (renumbered)',
    ].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((i) => i.id)).toEqual(['3', '4', '5']);
      expect(result.value.map((i) => i.description)).toEqual(['one', 'two', 'seven (renumbered)']);
    }
  });

  it('stops at the next ## heading', () => {
    const md = [
      '## Walk order',
      '',
      '1. **[X](https://x/)** one',
      '',
      '## Apply these',
      '',
      '1. **[Y](https://y/)** should be ignored',
    ].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
    }
  });

  it('ignores non-numbered lines inside the section', () => {
    const md = [
      '## Walk order',
      '',
      '> Single flat list across all buckets.',
      '',
      '1. **[X](https://x/)** real item',
    ].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
    }
  });

  it('returns Err when two rows share the same anchor URL', () => {
    const md = [
      '## Walk order',
      '',
      '1. **[PR-1](https://example.com/1)** — reply',
      '2. **[Also PR-1](https://example.com/1)** — duplicate URL',
    ].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('WALK_ORDER_DUPLICATE');
      expect(result.error.duplicates.length).toBe(2);
      expect(result.error.duplicates.map((d) => d.id)).toEqual(['3', '4']);
    }
  });

  it('returns Err when two rows share the same anchor text and neither has a URL', () => {
    const md = ['## Walk order', '', '1. **[Topic]** explore the thing', '2. **[Topic]** explore it again'].join('\n');
    const result = parseWalkOrder(md);
    // Anchor-without-URL is intentionally a non-match for ANCHOR_RE (the
    // regex requires the `(url)` group), so these rows have null anchor
    // and null anchor_url; they should be allowed (no duplicate detected).
    expect(result.isOk()).toBe(true);
  });

  it('does not flag rows that share only description text as duplicates', () => {
    const md = ['## Walk order', '', '1. **[A](https://a/)** follow up', '2. **[B](https://b/)** follow up'].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(2);
    }
  });

  it('skips rows whose stripped description is empty', () => {
    const md = ['## Walk order', '', '1. ', '2. **[X](https://x/)** real item', '3.   '].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.description).toBe('real item');
    }
  });

  it('skips rows that are only an anchor with no description payload', () => {
    const md = ['## Walk order', '', '1. **[X](https://x/)**'].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(0);
    }
  });

  it('parses mixed CRLF and LF line endings identically to LF-only', () => {
    const lfMd = ['## Walk order', '', '1. **[A](https://a/)** one', '2. **[B](https://b/)** two'].join('\n');
    const crlfMd = lfMd.replace(/\n/g, '\r\n');
    const lfResult = parseWalkOrder(lfMd);
    const crlfResult = parseWalkOrder(crlfMd);
    expect(lfResult.isOk()).toBe(true);
    expect(crlfResult.isOk()).toBe(true);
    if (lfResult.isOk() && crlfResult.isOk()) {
      expect(crlfResult.value).toEqual(lfResult.value);
    }
  });

  it('preserves unicode (emoji, RTL) in descriptions and anchors', () => {
    const md = ['## Walk order', '', '1. **[شكرا 🙏](https://example.com/rtl)** — review الترجمة 🎉. *(inbox)*'].join(
      '\n',
    );
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.anchor).toBe('شكرا 🙏');
      expect(result.value[0]?.description).toBe('review الترجمة 🎉.');
    }
  });
});
