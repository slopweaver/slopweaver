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

/**
 * Read + parse a JSON file.
 *
 * @param path the file path
 * @returns `{ ok: true, value }` or `{ ok: false, error }`
 */
export function readJson({ path }: { path: string }): ReadJsonResult {
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
 *
 * @param path the file path
 * @returns the file text (`ok('')` when absent), or `err` on any other read failure
 */
export function readOptionalText({ path }: { path: string }): Result<string> {
  try {
    return ok(readFileSync(resolve(path), 'utf8'))
  } catch (error: unknown) {
    if (isErrno(error) && error.code === 'ENOENT') {
      return ok('')
    }
    return err([error instanceof Error ? error.message : `failed to read ${path}`])
  }
}

/**
 * Read several optional files in order; the first real (non-ENOENT) read error short-circuits.
 *
 * @param paths the file paths, in order
 * @returns each file's text (absent ⇒ `''`), or the first real read error
 */
export function readOptionalTexts({ paths }: { paths: readonly string[] }): Result<readonly string[]> {
  const texts: string[] = []
  for (const path of paths) {
    const result = readOptionalText({ path })
    if (result.ok === false) {
      return err(result.errors)
    }
    texts.push(result.value)
  }
  return ok(texts)
}

/**
 * Append a row to a file, creating parent directories as needed.
 *
 * @param path the file path
 * @param row the exact bytes to append (include any trailing newline)
 */
export function appendLine({ path, row }: { path: string; row: string }): void {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  appendFileSync(resolve(path), row, { encoding: 'utf8' })
}
