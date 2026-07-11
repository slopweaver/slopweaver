import { describe, expect, it } from 'vitest'

import { scanContent } from './scan.js'

const noDenylist: readonly string[] = []

describe('scanContent', () => {
  it('flags an absolute home path', () => {
    // Assemble the path so this test file does not itself carry a literal the scanner would flag.
    const hits = scanContent({ path: 'a.ts', content: 'const p = "/ho' + 'me/alice/keys"', denylist: noDenylist })
    expect(hits.map((h) => h.label)).toContain('absolute-home-path')
  })

  it('flags token shapes only when a real token follows the prefix', () => {
    const real = scanContent({ path: 'a.ts', content: 'token=ghp_' + 'a'.repeat(30), denylist: noDenylist })
    expect(real.map((h) => h.label)).toContain('github-oauth-token')
    const bare = scanContent({ path: 'a.ts', content: 'the ghp_ prefix alone', denylist: noDenylist })
    expect(bare).toHaveLength(0)
  })

  it('flags a raw workspace-id shape', () => {
    const hits = scanContent({ path: 'a.ts', content: 'channel C0123' + 'ABCDEF here', denylist: noDenylist })
    expect(hits.map((h) => h.label)).toContain('raw-workspace-id')
  })

  it('applies a user denylist case-insensitively', () => {
    const hits = scanContent({ path: 'a.ts', content: 'my ACME Corp secret', denylist: ['acme corp'] })
    expect(hits.map((h) => h.label)).toContain('denylist')
  })

  it('returns nothing for clean content', () => {
    expect(scanContent({ path: 'a.ts', content: 'export const x = 1\n', denylist: noDenylist })).toHaveLength(0)
  })
})
