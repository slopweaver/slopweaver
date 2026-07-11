import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isErrno } from '../lib/parsers.js'
import { err, ok, type Result } from '../lib/result.js'

export type ReadJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

export function readJson(path: string): ReadJsonResult {
  try {
    return { ok: true, value: JSON.parse(readFileSync(resolve(path), 'utf8')) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `failed to read ${path}`,
    }
  }
}

/**
 * Read an OPTIONAL file: a genuinely-absent file (ENOENT) is `ok('')` (a first run with no state yet),
 * but any OTHER read error (permission, EISDIR, I/O) surfaces as `err`. Callers feeding dedup/planning
 * must NOT treat a permission/corrupt read as "empty" — that silently reprocesses or hides a broken
 * setup.
 */
export function readOptionalText(path: string): Result<string> {
  try {
    return ok(readFileSync(resolve(path), 'utf8'))
  } catch (error: unknown) {
    if (isErrno(error) && error.code === 'ENOENT') {
      return ok('')
    }
    return err([error instanceof Error ? error.message : `failed to read ${path}`])
  }
}

/** Read several optional files in order; the first real (non-ENOENT) read error short-circuits. */
export function readOptionalTexts(paths: readonly string[]): Result<readonly string[]> {
  const texts: string[] = []
  for (const path of paths) {
    const result = readOptionalText(path)
    if (result.ok === false) {
      return err(result.errors)
    }
    texts.push(result.value)
  }
  return ok(texts)
}

export function appendLine(path: string, row: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  appendFileSync(resolve(path), row, { encoding: 'utf8' })
}
