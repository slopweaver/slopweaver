/**
 * Read gold markdown back into `CorpusRecord`s (synthetic `gold` source), so a distilled finding is
 * retrievable + citable through the same ranker as bronze. One record per `## ` section (a whole doc is
 * too coarse to surface one fact); ids are stable across re-distils so re-ingesting collapses cleanly.
 * `tsIso` is caller-injected (build time) so recency-decay treats gold as fresh.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { goldDir } from '../corpus/corpusPaths.js'
import type { CorpusRecord } from '../corpus/types.js'

/** A heading → url-safe slug (lowercase alphanumeric runs joined by `-`). */
function slug({ heading }: { heading: string }): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** The `# ` title of a doc, if any. */
function docTitle({ markdown }: { markdown: string }): string | undefined {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
}

interface Section {
  readonly heading: string
  readonly body: string
}

/** Split a doc into its `## ` sections (heading + body). */
function sections({ markdown }: { markdown: string }): readonly Section[] {
  const parts = markdown.split(/^##\s+(.+)$/m)
  const out: Section[] = []
  // parts = [preamble, heading1, body1, heading2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const heading = (parts[i] ?? '').trim()
    const body = (parts[i + 1] ?? '').trim()
    if (heading.length > 0 && body.length > 0) {
      out.push({ heading, body })
    }
  }
  return out
}

/** Every `.md` file under `dir`, recursively, sorted. */
function markdownFiles({ dir }: { dir: string }): readonly string[] {
  let entries: readonly string[]
  try {
    entries = readdirSync(dir).slice().sort()
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...markdownFiles({ dir: full }))
    } else if (entry.endsWith('.md')) {
      files.push(full)
    }
  }
  return files
}

/**
 * Read gold markdown into corpus records.
 *
 * @param home the world-model home (defaults to the resolved home)
 * @param tsIso the build timestamp to stamp on every gold record (so it ranks as fresh)
 * @returns the gold records (empty when there's no gold dir)
 */
export function readGoldRecords({ home, tsIso }: { home?: string; tsIso: string }): readonly CorpusRecord[] {
  const root = goldDir(home === undefined ? {} : { home })
  const records: CorpusRecord[] = []
  for (const file of markdownFiles({ dir: root })) {
    const markdown = readFileSync(file, 'utf8')
    const title = docTitle({ markdown })
    const docPath = relative(root, file)
    for (const section of sections({ markdown })) {
      // `ref` is the doc-relative anchor; the `gold:` cite-token prefix and the `gold://` URL scheme are
      // each applied once to it, so neither is doubled (a `gold://gold:…` URL would be malformed).
      const ref = `${docPath}#${slug({ heading: section.heading })}`
      const sourceId = `gold:${ref}`
      const recordTitle = title !== undefined ? `${title} — ${section.heading}` : section.heading
      records.push({
        source: 'gold',
        sourceId,
        url: `gold://${ref}`,
        tsIso,
        kind: 'finding',
        container: 'gold',
        title: recordTitle,
        text: `${recordTitle}\n${section.body}`,
        refs: [],
      })
    }
  }
  return records
}
