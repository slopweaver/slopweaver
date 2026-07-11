/**
 * Catalog renderers — the human + machine views of the command registry, both derived from the SINGLE
 * `discoverCommands(NOUN_GROUPS)` source so they can never drift from what is actually wired:
 *   - `renderCatalog`     : the recall view ("what can slopweaver do"), every verb grouped by noun with
 *                           its one-line summary (or `(undocumented)` for a bare handler) + coverage.
 *   - `renderCatalogJson` : the machine-enumerable surface a future planner / doc-sync consumes.
 *   - `renderCapabilities`: the self-describe view — the DOCUMENTED verbs with their approval +
 *                           work-item hints.
 * Pure: take the discovered list, return a string. No I/O.
 */

import type { DiscoveredCommand } from './discoverCommands.js'

/** Group commands by noun, preserving the (already noun,verb-sorted) order. */
function byNoun<T extends { readonly noun: string }>(commands: readonly T[]): readonly (readonly [string, readonly T[]])[] {
  const groups = new Map<string, T[]>()
  for (const command of commands) {
    const bucket = groups.get(command.noun) ?? []
    bucket.push(command)
    groups.set(command.noun, bucket)
  }
  return [...groups.entries()]
}

const PAD = 16

/** Human recall view: every verb under its noun, summary or `(undocumented)`, plus a coverage footer. */
export function renderCatalog(commands: readonly DiscoveredCommand[]): string {
  const documented = commands.filter((c) => c.meta !== undefined).length
  const nouns = byNoun(commands)
  const header = `slopweaver — ${String(commands.length)} commands across ${String(nouns.length)} nouns (${String(documented)} documented)`
  const lines: string[] = [header]
  for (const [noun, verbs] of nouns) {
    lines.push('', noun)
    for (const command of verbs) {
      const summary = command.meta?.summary ?? '(undocumented)'
      lines.push(`  ${command.verb.padEnd(PAD)} ${summary}`)
    }
  }
  return lines.join('\n')
}

/** JSON view — the machine-enumerable surface a future planner / doc-sync consumes. */
export function renderCatalogJson(commands: readonly DiscoveredCommand[]): string {
  return JSON.stringify(
    commands.map((c) => ({
      noun: c.noun,
      verb: c.verb,
      documented: c.meta !== undefined,
      ...(c.meta === undefined
        ? {}
        : {
          summary: c.meta.summary,
          ...(c.meta.example === undefined ? {} : { example: c.meta.example }),
          requiresApproval: c.meta.requiresApproval === true,
          createsWorkItem: c.meta.createsWorkItem === true,
        }),
    })),
    null,
    2,
  )
}

/** A capability flag suffix: which documented verbs mutate (approval) or create tracked work. */
function flags({ command }: { command: Required<DiscoveredCommand> }): string {
  const parts: string[] = []
  if (command.meta.requiresApproval === true) {
    parts.push('approval')
  }
  if (command.meta.createsWorkItem === true) {
    parts.push('creates-work-item')
  }
  return parts.length === 0 ? '' : `  [${parts.join(', ')}]`
}

/**
 * Self-describe view: the DOCUMENTED verbs grouped by noun, with approval / work-item hints. Notes how
 * many verbs remain un-described so the surface is honest about coverage.
 */
export function renderCapabilities(commands: readonly DiscoveredCommand[]): string {
  const documented = commands.filter((c): c is Required<DiscoveredCommand> => c.meta !== undefined)
  const undocumented = commands.length - documented.length
  if (documented.length === 0) {
    return 'No commands are self-described yet.'
  }
  const header = `I can run ${String(documented.length)} described commands${undocumented > 0 ? ` (+${String(undocumented)} more not yet self-described)` : ''}:`
  const lines: string[] = [header]
  for (const [noun, verbs] of byNoun(documented)) {
    lines.push('', noun)
    for (const command of verbs) {
      lines.push(`  ${command.verb.padEnd(PAD)} ${command.meta.summary}${flags({ command })}`)
    }
  }
  return lines.join('\n')
}
