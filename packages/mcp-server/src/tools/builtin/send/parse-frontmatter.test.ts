import { describe, expect, it } from 'vitest';
import { hashFrontmatter, parseFrontmatter, serializeDraft } from './parse-frontmatter.ts';

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

describe('hashFrontmatter', () => {
  it('produces a stable hex hash for the same input', () => {
    const h1 = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1' } });
    const h2 = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1' } });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is order-independent (sort-stable)', () => {
    const h1 = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1' } });
    const h2 = hashFrontmatter({ frontmatter: { target: 'slack:C1', draft_id: 'a' } });
    expect(h1).toBe(h2);
  });

  it('ignores the `status` field so record_send_outcome can rewrite it without invalidating the hash', () => {
    const before = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1' } });
    const afterSent = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1', status: 'sent' } });
    const afterFailed = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1', status: 'failed' } });
    expect(before).toBe(afterSent);
    expect(before).toBe(afterFailed);
  });

  it('changes when target or draft_id change', () => {
    const base = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C1' } });
    const changedId = hashFrontmatter({ frontmatter: { draft_id: 'b', target: 'slack:C1' } });
    const changedTarget = hashFrontmatter({ frontmatter: { draft_id: 'a', target: 'slack:C2' } });
    expect(changedId).not.toBe(base);
    expect(changedTarget).not.toBe(base);
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
