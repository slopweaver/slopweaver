import { describe, expect, it } from 'vitest';
import { appendDirectives } from './append.ts';

describe('appendDirectives', () => {
  it('seeds a Hard rules section in an empty file', () => {
    const r = appendDirectives({ body: '', directives: [{ type: 'forbid', token: 'delve' }] });
    expect(r.updated).toBe('## Hard rules\n\n- forbid: delve\n');
    expect(r.added).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('appends to an existing Hard rules section, before the next heading', () => {
    const body = [
      '# Voice rules',
      '',
      '## Hard rules',
      '',
      '- forbid: leverage',
      '',
      '## Defaults',
      '',
      '- forbid: utilize',
      '',
    ].join('\n');
    const r = appendDirectives({
      body,
      directives: [{ type: 'forbid', token: 'delve' }],
    });
    expect(r.updated).toContain('- forbid: leverage\n- forbid: delve\n\n## Defaults');
    expect(r.updated).toContain('- forbid: utilize');
    expect(r.added).toHaveLength(1);
  });

  it('appends to a Hard rules section that runs to EOF', () => {
    const body = ['## Hard rules', '', '- forbid: leverage', ''].join('\n');
    const r = appendDirectives({
      body,
      directives: [{ type: 'replace', from: 'utilize', to: 'use' }],
    });
    expect(r.updated.endsWith('- forbid: leverage\n- replace: utilize => use\n')).toBe(true);
  });

  it('creates a Hard rules section when only other headings exist', () => {
    const body = '## Defaults\n\n- forbid: leverage\n';
    const r = appendDirectives({
      body,
      directives: [{ type: 'pattern', regex: '\\bnotably\\b' }],
    });
    expect(r.updated).toContain('## Defaults');
    expect(r.updated).toContain('## Hard rules');
    expect(r.updated).toContain('- pattern: \\bnotably\\b');
  });

  it('is idempotent when the directive already exists verbatim', () => {
    const body = '## Hard rules\n\n- forbid: delve\n';
    const r = appendDirectives({ body, directives: [{ type: 'forbid', token: 'delve' }] });
    expect(r.updated).toBe(body);
    expect(r.added).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it('skips duplicates but still adds new directives from the same call', () => {
    const body = '## Hard rules\n\n- forbid: delve\n';
    const r = appendDirectives({
      body,
      directives: [
        { type: 'forbid', token: 'delve' },
        { type: 'forbid', token: 'notably' },
      ],
    });
    expect(r.added.map((d) => (d.type === 'forbid' ? d.token : ''))).toEqual(['notably']);
    expect(r.skipped).toHaveLength(1);
    expect(r.updated).toContain('- forbid: delve');
    expect(r.updated).toContain('- forbid: notably');
  });

  it('appends multiple new directives in one call, preserving order', () => {
    const r = appendDirectives({
      body: '',
      directives: [
        { type: 'forbid', token: 'leverage' },
        { type: 'replace', from: '!', to: '.' },
        { type: 'pattern', regex: '\\bit.s not X, it.s Y\\b' },
      ],
    });
    const lines = r.updated.trim().split('\n');
    expect(lines).toContain('- forbid: leverage');
    expect(lines).toContain('- replace: ! => .');
    expect(lines).toContain('- pattern: \\bit.s not X, it.s Y\\b');
    const idxF = lines.indexOf('- forbid: leverage');
    const idxR = lines.indexOf('- replace: ! => .');
    const idxP = lines.indexOf('- pattern: \\bit.s not X, it.s Y\\b');
    expect(idxF).toBeLessThan(idxR);
    expect(idxR).toBeLessThan(idxP);
  });

  it('preserves trailing newline conventions', () => {
    const body = '## Hard rules\n\n- forbid: leverage';
    const r = appendDirectives({ body, directives: [{ type: 'forbid', token: 'delve' }] });
    expect(r.updated.endsWith('\n')).toBe(true);
  });
});
