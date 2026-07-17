import { describe, expect, it } from 'vitest'

import { RAW_ESCAPE, classifyRawCommand } from './rawTools.js'

/** Whether a command is blocked with the raw escape OFF (the default-deny path). */
function isBlocked({ command }: { command: string }): boolean {
  return classifyRawCommand({ command, allowRaw: false }).blocked
}

/** Assert a command is blocked and return its message (throws otherwise — keeps assertions unconditional). */
function blockedMessage({ command }: { command: string }): string {
  const verdict = classifyRawCommand({ command, allowRaw: false })
  if (!verdict.blocked) {
    throw new Error(`expected blocked for: ${command}`)
  }
  return verdict.message
}

describe('classifyRawCommand', () => {
  it('blocks a mutating gh command with the escape in the message', () => {
    expect(blockedMessage({ command: 'gh pr merge 1' })).toContain(RAW_ESCAPE)
  })

  it('blocks gh api with a write method (spaced, attached, and = forms)', () => {
    expect(isBlocked({ command: 'gh api -X POST /repos/x/y/issues' })).toBe(true)
    expect(isBlocked({ command: 'gh api --method=DELETE /repos/x/y/issues/1' })).toBe(true)
    expect(isBlocked({ command: 'gh api -XPATCH /repos/x/y' })).toBe(true)
  })

  it('blocks destructive git (reset --hard, push, branch -D)', () => {
    expect(isBlocked({ command: 'git reset --hard HEAD~1' })).toBe(true)
    expect(isBlocked({ command: 'git push origin main' })).toBe(true)
    expect(isBlocked({ command: 'git branch -D feature' })).toBe(true)
  })

  it('blocks destructive git hidden behind global flags (-C, --git-dir)', () => {
    expect(isBlocked({ command: 'git -C /tmp/repo push origin main' })).toBe(true)
    expect(isBlocked({ command: 'git --git-dir=.git push origin main' })).toBe(true)
    expect(isBlocked({ command: 'git -c user.name=x reset --hard HEAD' })).toBe(true)
  })

  it('blocks a raw op behind an env/VAR=VAL prefix', () => {
    expect(isBlocked({ command: 'env GIT_SSH=x git push origin main' })).toBe(true)
    expect(isBlocked({ command: 'FOO=bar gh pr merge 1' })).toBe(true)
  })

  it('blocks curl and wget', () => {
    expect(isBlocked({ command: 'curl -X POST https://api.example.com' })).toBe(true)
    expect(isBlocked({ command: 'wget https://example.com/x' })).toBe(true)
  })

  it('allows read-only git and gh (not heavy-handed)', () => {
    expect(isBlocked({ command: 'git status' })).toBe(false)
    expect(isBlocked({ command: 'git log --oneline' })).toBe(false)
    expect(isBlocked({ command: 'git ls-files' })).toBe(false)
    expect(isBlocked({ command: 'git -C /tmp/repo status' })).toBe(false)
    expect(isBlocked({ command: 'gh pr view 1' })).toBe(false)
    expect(isBlocked({ command: 'gh api /repos/x/y' })).toBe(false)
  })

  it('allows unrecognised commands', () => {
    expect(isBlocked({ command: 'node build.js' })).toBe(false)
  })

  it('allows a would-be-blocked command under the SLOPWEAVER_ALLOW_RAW escape', () => {
    const verdict = classifyRawCommand({ command: 'gh pr merge 1', allowRaw: true })
    expect(verdict.blocked).toBe(false)
    expect(verdict.tool).toBe('gh')
  })
})
