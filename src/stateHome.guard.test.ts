/**
 * The single-contract guard. It fails the build if any module derives a `$SLOPWEAVER_HOME` sub-path on
 * its own instead of importing it from `stateHome.ts` — the invariant that keeps every belief, ledger,
 * corpus, and seed file agreeing on one layout. Scans the working-tree source (not just tracked files)
 * so a brand-new offender is caught before it is ever committed.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = dirname(fileURLToPath(import.meta.url))

/** Every non-test `.ts` under `src/`, repo-relative-ish (from src/). */
function sourceFiles({ dir }: { dir: string }): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles({ dir: full }))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** A forbidden home-path derivation + the only file allowed to contain it. */
interface Rule {
  readonly label: string
  readonly re: RegExp
  readonly allow: string
}

const RULES: readonly Rule[] = [
  { label: 'join(home, …) — build home paths only in stateHome.ts', re: /join\(\s*home\b/, allow: 'stateHome.ts' },
  { label: 'join(slopweaverHome(), …) — build home paths only in stateHome.ts', re: /join\(\s*slopweaverHome\(\)/, allow: 'stateHome.ts' },
  { label: "'.slopweaver' default-home literal — only config.ts owns it", re: /'\.slopweaver'/, allow: 'config.ts' },
]

describe('state-home single-contract guard', () => {
  it('derives no $SLOPWEAVER_HOME sub-path outside stateHome.ts (config.ts owns the root literal)', () => {
    const files = sourceFiles({ dir: srcRoot })
    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      for (const rule of RULES) {
        lines.forEach((line, index) => {
          if (rule.re.test(line) && !file.endsWith(`/${rule.allow}`)) {
            violations.push(`${file.slice(srcRoot.length + 1)}:${String(index + 1)} — ${rule.label}`)
          }
        })
      }
    }
    expect(violations).toEqual([])
  })

  it('actually scans a meaningful number of source files (the walk is not silently empty)', () => {
    expect(sourceFiles({ dir: srcRoot }).length).toBeGreaterThan(20)
  })
})
