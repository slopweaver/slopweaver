/**
 * The effectful edge that reads the persona seed `$SLOPWEAVER_HOME/profile.json` back into a {@link
 * Profile}. Kept behind `safeFs` (a missing/garbled file ⇒ `undefined`, never a throw): the owner lens
 * treats an absent profile as "no owner", so retrieval simply falls back to an ordinary org ask. The
 * strict {@link parseProfile} still runs, so a corrupt hand-edit is dropped (not silently half-parsed).
 */
import { readFileSync } from "node:fs";

import { parseJson } from "./lib/jsonParse.js";
import { safeFs } from "./lib/safeBoundary.js";
import { type Profile, parseProfile } from "./profile.js";
import { stateHomePaths } from "./stateHome.js";

/**
 * Read + parse the off-repo persona seed (`undefined` when absent, unreadable, or invalid).
 *
 * @param home the world-model home
 * @returns the validated profile, or `undefined`
 */
export function loadProfile({ home }: { home: string }): Profile | undefined {
  const path = stateHomePaths({ home }).profileJson;
  const read = safeFs({ execute: () => readFileSync(path, "utf8"), operation: "readProfile", path });
  if (read.isErr()) {
    return undefined;
  }
  const parsed = parseJson({ text: read.value });
  if (parsed.isErr()) {
    return undefined;
  }
  const profile = parseProfile({ value: parsed.value });
  return profile.ok ? profile.value : undefined;
}
