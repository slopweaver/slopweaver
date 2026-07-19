/**
 * The effectful edge that reads the off-repo `$SLOPWEAVER_HOME/identity.json` roster — the human
 * override/seed for cross-source identity. Kept behind `safeFs` (a missing/garbled file ⇒ an empty roster,
 * never a throw) and shared by `derive` + the `identity` verb so the boundary is in exactly one place.
 */
import { readFileSync } from "node:fs";
import { safeFs } from "../lib/safeBoundary.js";
import { stateHomePaths } from "../stateHome.js";
import { type IdentityRecord, parseIdentityRecords } from "./identity.js";

/**
 * Read + parse the off-repo identity roster (empty when absent/garbled).
 *
 * @param home the world-model home
 * @returns the parsed roster records (malformed entries skipped)
 */
export function loadIdentityRoster({ home }: { home: string }): readonly IdentityRecord[] {
  const path = stateHomePaths({ home }).identityJson;
  const read = safeFs({ execute: () => readFileSync(path, "utf8"), operation: "readIdentityRoster", path });
  return parseIdentityRecords({ content: read.isOk() ? read.value : "[]" });
}
