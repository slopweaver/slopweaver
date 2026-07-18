/**
 * Load the full searchable corpus: bronze records + gold-as-records, over one flat readable set. The
 * effectful edge shared by `ask` and `facts`. `err` when there's no bronze corpus yet (the verb maps
 * that to an expected-empty exit).
 */

import { readCorpusDir, resolveCorpusDir } from "../corpus/corpusStore.js";
import type { CorpusRecord } from "../corpus/types.js";
import { err, ok, type Result } from "../lib/result.js";
import { readGoldRecords } from "./goldRecords.js";

/**
 * Load bronze + gold records for retrieval.
 *
 * @param home the world-model home
 * @param corpus an explicit corpus dir override (bronze)
 * @param nowIso the timestamp to stamp gold records with (so they rank as fresh)
 * @returns the combined records, or an error when no corpus exists
 */
export function loadCorpus({
  home,
  corpus,
  nowIso,
}: {
  home?: string;
  corpus?: string;
  nowIso: string;
}): Result<readonly CorpusRecord[]> {
  const dir = resolveCorpusDir({
    ...(home !== undefined ? { home } : {}),
    ...(corpus !== undefined ? { corpus } : {}),
  });
  if (dir.ok === false) {
    return err(dir.errors);
  }
  const bronze = readCorpusDir({ dir: dir.value });
  const gold = readGoldRecords({ ...(home !== undefined ? { home } : {}), tsIso: nowIso });
  return ok([...(bronze.ok ? bronze.value : []), ...gold], bronze.warnings);
}
