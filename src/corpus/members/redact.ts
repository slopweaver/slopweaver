/**
 * Member-specific redaction. The record-bronze writer scrubs emails, which would destroy the very field
 * member hydration exists to capture — so member rows use {@link redactSecrets} (tokens + long digit runs
 * ONLY, emails PRESERVED) recursively over the raw payload. Real emails living in member bronze is by
 * design: it is off-repo under `$SLOPWEAVER_HOME`, and the public leak gate scans the repo, not the home.
 * The curated `identity` email is a deliberate join key and is likewise preserved.
 */
import { isRecord } from "../../lib/parsers.js";
import { redactSecrets } from "../redact.js";
import type { MemberBronzeRow } from "./types.js";

/**
 * Recursively scrub secret classes from every string LEAF of a raw JSON value, preserving structure, keys,
 * and emails. Non-strings pass through. Pure.
 *
 * @param value any JSON value from a raw member payload
 * @returns the same-shaped value with token/number leaves scrubbed (emails intact)
 */
export function redactMemberRawValue({ value }: { value: unknown }): unknown {
  if (typeof value === "string") {
    return redactSecrets({ text: value }).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMemberRawValue({ value: item }));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redactMemberRawValue({ value: inner });
    }
    return out;
  }
  return value;
}

/**
 * Scrub a member row before it is written: the raw payload's string leaves are secret-scrubbed (emails
 * kept), and the free-text profile fields (title) are secret-scrubbed too. The curated identity email /
 * normalised email / handle / name are the intentional join+display fields and are left intact. Pure.
 *
 * @param row the member row to scrub
 * @returns a new row with secrets removed, emails + identity join fields preserved
 */
export function redactMemberRow({ row }: { row: MemberBronzeRow }): MemberBronzeRow {
  const title = row.profile.title;
  return {
    ...row,
    profile: { ...row.profile, ...(title !== undefined ? { title: redactSecrets({ text: title }).text } : {}) },
    raw: redactMemberRawValue({ value: row.raw }),
  };
}
