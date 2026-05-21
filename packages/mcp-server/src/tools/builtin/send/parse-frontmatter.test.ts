import { describe, expect, it } from 'vitest';
import { hashContent, parseFrontmatter, serializeDraft } from './parse-frontmatter.ts';

describe('parseFrontmatter', () => {
  it('parses a well-formed frontmatter block + body', () => {
    const input = '---\ndraft_id: abc\ntarget: slack:C123\n---\n\nReply body here.\n';
    const r = parseFrontmatter({ input });
    expect(r).not.toBeNull();
    if (r != null) {
      expect(r.frontmatter['draft_id']).toBe('abc');
      expect(r.frontmatter['target']).toBe('slack:C123');
      expect(r.body.trim()).toBe('Reply body here.');
    }
  });

  it('returns null for missing opening fence', () => {
    expect(parseFrontmatter({ input: 'no frontmatter here' })).toBeNull();
  });

  it('returns null for missing closing fence', () => {
    expect(parseFrontmatter({ input: '---\ndraft_id: abc\nbody without close' })).toBeNull();
  });

  it('ignores blank lines and lines without colons', () => {
    const input = '---\n\ndraft_id: abc\nthis is a comment\ntarget: slack:C1\n---\nbody';
    const r = parseFrontmatter({ input });
    expect(r).not.toBeNull();
    if (r != null) {
      expect(r.frontmatter).toEqual({ draft_id: 'abc', target: 'slack:C1' });
    }
  });
});

describe('hashContent', () => {
  it('produces a stable hex hash for the same input', () => {
    const h1 = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'hello' });
    const h2 = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'hello' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is order-independent for frontmatter keys (sort-stable)', () => {
    const h1 = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'hello' });
    const h2 = hashContent({ frontmatter: { target: 'slack:C1', draft_id: 'a' }, body: 'hello' });
    expect(h1).toBe(h2);
  });

  it('ignores the `status` field so record_send_outcome can rewrite it without invalidating the hash', () => {
    const before = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'hi' });
    const afterSent = hashContent({
      frontmatter: { draft_id: 'a', target: 'slack:C1', status: 'sent' },
      body: 'hi',
    });
    const afterFailed = hashContent({
      frontmatter: { draft_id: 'a', target: 'slack:C1', status: 'failed' },
      body: 'hi',
    });
    expect(before).toBe(afterSent);
    expect(before).toBe(afterFailed);
  });

  it('changes when target or draft_id change', () => {
    const base = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'hi' });
    const changedId = hashContent({ frontmatter: { draft_id: 'b', target: 'slack:C1' }, body: 'hi' });
    const changedTarget = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C2' }, body: 'hi' });
    expect(changedId).not.toBe(base);
    expect(changedTarget).not.toBe(base);
  });

  it('changes when the body changes (body coverage is the iter-3 fix)', () => {
    const base = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'original' });
    const edited = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'EDITED' });
    expect(edited).not.toBe(base);
  });

  it('treats body whitespace at the edges as insignificant (trim)', () => {
    const base = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: 'hi there' });
    const padded = hashContent({ frontmatter: { draft_id: 'a', target: 'slack:C1' }, body: '  hi there\n' });
    expect(padded).toBe(base);
  });
});

describe('serializeDraft', () => {
  it('round-trips parseFrontmatter → serializeDraft for a basic draft', () => {
    const input = '---\ndraft_id: abc\ntarget: slack:C1\n---\nbody here\n';
    const parsed = parseFrontmatter({ input });
    expect(parsed).not.toBeNull();
    if (parsed != null) {
      const out = serializeDraft({ frontmatter: parsed.frontmatter, body: parsed.body });
      const reparsed = parseFrontmatter({ input: out });
      expect(reparsed?.frontmatter).toEqual(parsed.frontmatter);
      expect(reparsed?.body).toBe(parsed.body);
    }
  });

  it('emits keys in sorted order', () => {
    const out = serializeDraft({ frontmatter: { target: 'slack:C1', draft_id: 'a' }, body: 'b' });
    // draft_id < target alphabetically
    expect(out).toBe('---\ndraft_id: a\ntarget: slack:C1\n---\nb');
  });
});
