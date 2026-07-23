/**
 * Pure field readers shared by the member connectors (projecting a raw SDK object into a typed
 * {@link MemberBronzeRow}) and by the store (parsing a persisted row back). Centralising them keeps the
 * curated `identity`/`profile` projection defined in exactly one place — no casts, every field defensive.
 */

import { isRecord } from "../../lib/parsers.js";
import type { IdentitySource } from "../../silver/identity.js";
import type { EmailTrust, MemberIdentityFields, MemberProfileFields } from "./types.js";

/** A non-empty string off an unknown, else `undefined`. Pure. */
export function optStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A boolean off an unknown, else `undefined` (so a missing flag stays absent, not a fake `false`). Pure. */
export function optBool({ value }: { value: unknown }): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A string list off an unknown (non-strings dropped), else `undefined` when absent/empty. Pure. */
export function optStrList({ value }: { value: unknown }): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length > 0 ? list : undefined;
}

/** Whether a value is one of the trust tiers (defensive parse-back). Positional — used as a guard. */
function isEmailTrust(value: unknown): value is EmailTrust {
  return value === "trusted" || value === "weak" || value === "missing";
}

/** Read a persisted/curated {@link MemberIdentityFields} off a raw object (defensive, no cast). Pure. */
export function readMemberIdentity({
  value,
  source,
}: {
  value: unknown;
  source: IdentitySource;
}): MemberIdentityFields {
  const obj = isRecord(value) ? value : {};
  const handle = optStr({ value: obj["handle"] });
  const name = optStr({ value: obj["name"] });
  const email = optStr({ value: obj["email"] });
  const emailNormalised = optStr({ value: obj["emailNormalised"] });
  return {
    emailTrust: isEmailTrust(obj["emailTrust"]) ? obj["emailTrust"] : "missing",
    // A stored row always carries a nativeId (the store validated it on write); a corrupt/absent one
    // degrades to "" honestly (it matches nothing) rather than coalescing a fake — see the fail-loud rule.
    nativeId: typeof obj["nativeId"] === "string" ? obj["nativeId"] : "",
    source,
    ...(handle !== undefined ? { handle } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(emailNormalised !== undefined ? { emailNormalised } : {}),
  };
}

/** Read a persisted/curated {@link MemberProfileFields} off a raw object (defensive, no cast). Pure. */
export function readMemberProfile({ value }: { value: unknown }): MemberProfileFields {
  const obj = isRecord(value) ? value : {};
  const title = optStr({ value: obj["title"] });
  const timezone = optStr({ value: obj["timezone"] });
  const avatarUrl = optStr({ value: obj["avatarUrl"] });
  const teams = optStrList({ value: obj["teams"] });
  const active = optBool({ value: obj["active"] });
  const admin = optBool({ value: obj["admin"] });
  const guest = optBool({ value: obj["guest"] });
  const bot = optBool({ value: obj["bot"] });
  return {
    ...(title !== undefined ? { title } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(teams !== undefined ? { teams } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(admin !== undefined ? { admin } : {}),
    ...(guest !== undefined ? { guest } : {}),
    ...(bot !== undefined ? { bot } : {}),
  };
}
