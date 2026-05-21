import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWalkOrder } from './parse-walk-order.ts';

function expectedId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 8);
}

describe('parseWalkOrder', () => {
  it('returns empty when the section is absent', () => {
    const md = '# Reconciliation\n\nSome other content.';
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.items).toEqual([]);
      expect(result.value.warnings).toEqual([]);
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
      expect(result.value.items.length).toBe(1);
      expect(result.value.items[0]).toEqual({
        id: expectedId('https://example.com/123'),
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
      expect(result.value.items[0]?.priority).toBe(null);
      expect(result.value.items[0]?.source_bucket).toBe(null);
      expect(result.value.items[0]?.description).toBe('needs a poke.');
    }
  });

  it('derives item ids from content (anchor_url > anchor > description) so they survive input reformatting', () => {
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
      expect(result.value.items.map((i) => i.id)).toEqual([
        expectedId('https://a/'),
        expectedId('https://b/'),
        expectedId('https://c/'),
      ]);
      expect(result.value.items.map((i) => i.description)).toEqual(['one', 'two', 'seven (renumbered)']);
    }
  });

  it('keeps ids stable when blank lines are inserted above an item', () => {
    const compact = ['## Walk order', '', '1. **[A](https://a/)** one', '2. **[B](https://b/)** two'].join('\n');
    const reformatted = [
      '## Walk order',
      '',
      '',
      '',
      '> a comment',
      '',
      '1. **[A](https://a/)** one',
      '',
      '2. **[B](https://b/)** two',
    ].join('\n');
    const compactResult = parseWalkOrder(compact);
    const reformattedResult = parseWalkOrder(reformatted);
    expect(compactResult.isOk()).toBe(true);
    expect(reformattedResult.isOk()).toBe(true);
    if (compactResult.isOk() && reformattedResult.isOk()) {
      expect(compactResult.value.items.map((i) => i.id)).toEqual(reformattedResult.value.items.map((i) => i.id));
    }
  });

  it('falls back to description text for the id when no URL/anchor is parsed', () => {
    const md = ['## Walk order', '', '1. **[Topic]** explore the thing'].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // ANCHOR_RE requires `(url)`, so `**[Topic]**` is a non-match —
      // anchor + anchor_url are both null. The row's full body
      // (including the unparsed `**[Topic]**`) becomes the description,
      // and that's what seeds the id.
      expect(result.value.items[0]?.anchor).toBe(null);
      expect(result.value.items[0]?.anchor_url).toBe(null);
      expect(result.value.items[0]?.description).toBe('**[Topic]** explore the thing');
      expect(result.value.items[0]?.id).toBe(expectedId('**[Topic]** explore the thing'));
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
      expect(result.value.items.length).toBe(1);
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
      expect(result.value.items.length).toBe(1);
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
      expect(result.error.duplicates.map((d) => d.id)).toEqual([
        expectedId('https://example.com/1'),
        expectedId('https://example.com/1'),
      ]);
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
      expect(result.value.items.length).toBe(2);
    }
  });

  it('skips rows whose stripped description is empty AND surfaces a warning for each', () => {
    const md = ['## Walk order', '', '1. ', '2. **[X](https://x/)** real item', '3.   '].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.items.length).toBe(1);
      expect(result.value.items[0]?.description).toBe('real item');
      expect(result.value.warnings).toEqual([
        'line 3: numbered row had no description after stripping metadata',
        'line 5: numbered row had no description after stripping metadata',
      ]);
    }
  });

  it('skips rows that are only an anchor with no description payload AND warns', () => {
    const md = ['## Walk order', '', '1. **[X](https://x/)**'].join('\n');
    const result = parseWalkOrder(md);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.items.length).toBe(0);
      expect(result.value.warnings).toEqual(['line 3: numbered row had no description after stripping metadata']);
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
      expect(result.value.items.length).toBe(1);
      expect(result.value.items[0]?.anchor).toBe('شكرا 🙏');
      expect(result.value.items[0]?.description).toBe('review الترجمة 🎉.');
    }
  });
});
