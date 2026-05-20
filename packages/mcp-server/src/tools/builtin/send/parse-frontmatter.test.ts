import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './parse-frontmatter.ts';

describe('parseFrontmatter', () => {
  it('parses a well-formed frontmatter block + body', () => {
    const input = '---\ndraft_id: abc\ntarget: slack:C123\n---\n\nReply body here.\n';
    const r = parseFrontmatter(input);
    expect(r).not.toBeNull();
    if (r != null) {
      expect(r.frontmatter['draft_id']).toBe('abc');
      expect(r.frontmatter['target']).toBe('slack:C123');
      expect(r.body.trim()).toBe('Reply body here.');
    }
  });

  it('returns null for missing opening fence', () => {
    expect(parseFrontmatter('no frontmatter here')).toBeNull();
  });

  it('returns null for missing closing fence', () => {
    expect(parseFrontmatter('---\ndraft_id: abc\nbody without close')).toBeNull();
  });

  it('ignores blank lines and lines without colons', () => {
    const input = '---\n\ndraft_id: abc\nthis is a comment\ntarget: slack:C1\n---\nbody';
    const r = parseFrontmatter(input);
    expect(r).not.toBeNull();
    if (r != null) {
      expect(r.frontmatter).toEqual({ draft_id: 'abc', target: 'slack:C1' });
    }
  });
});
