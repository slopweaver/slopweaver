/**
 * Email trust classification for member hydration — the data-first (D8) rule that decides whether a
 * captured email is a safe cross-source JOIN key or must be HELD. A `noreply`/role/shared alias, or an
 * email seen on more than one member of the SAME source, is `weak`: kept in the dossier but never fed to
 * the resolver as an email, so it can never wrong-merge two distinct humans. Pure — no I/O.
 */
import type { IdentitySource } from "../../silver/identity.js";
import type { EmailTrust, MemberBronzeRow, MemberIdentityFields } from "./types.js";

/**
 * Local-parts that denote a ROLE/shared mailbox rather than one human — an email at any of these HOLDS.
 * Kept explicit + exact (no fuzzy matching): the local-part must equal one of these, case-insensitively.
 */
const SHARED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "billing",
  "contact",
  "dev",
  "engineering",
  "hello",
  "help",
  "info",
  "it",
  "noreply",
  "no-reply",
  "security",
  "support",
  "team",
  "workspace",
]);

/** Lower-case + trim an email for joining (mirrors the resolver's `normaliseEmail`). Pure. */
export function normaliseMemberEmail({ email }: { email: string }): string {
  return email.trim().toLowerCase();
}

/**
 * Why an email is WEAK (HELD, never merged), or `undefined` when it is a trusted personal address. Catches
 * GitHub `noreply` addresses (`*@users.noreply.github.com` + any `noreply`/`no-reply` local-part) and the
 * role/shared mailboxes above. Pure — the same-email-on-many-members case is handled by {@link sharedEmails}.
 *
 * @param email the raw email
 * @returns the weak reason (e.g. `noreply`, `shared-alias:support`), or `undefined` when trusted
 */
export function weakEmailReason({ email }: { email: string }): string | undefined {
  const norm = normaliseMemberEmail({ email });
  const at = norm.indexOf("@");
  if (at <= 0) {
    return "malformed";
  }
  const local = norm.slice(0, at);
  const domain = norm.slice(at + 1);
  if (domain.endsWith("noreply.github.com") || domain === "users.noreply.github.com") {
    return "noreply";
  }
  return SHARED_LOCAL_PARTS.has(local) ? `shared-alias:${local}` : undefined;
}

/**
 * The set of normalised emails claimed by MORE THAN ONE member of the same source — a shared/duplicated
 * mailbox that must HOLD, not merge. Pure.
 *
 * @param rows the member rows for one source
 * @returns the normalised emails seen on 2+ distinct native ids
 */
export function sharedEmails({ rows }: { rows: readonly MemberBronzeRow[] }): ReadonlySet<string> {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    const norm = row.identity.emailNormalised;
    if (norm !== undefined && norm.length > 0) {
      owners.set(norm, (owners.get(norm) ?? new Set()).add(row.sourceId));
    }
  }
  return new Set([...owners].filter(([, ids]) => ids.size > 1).map(([norm]) => norm));
}

/**
 * Classify a captured email into its {@link EmailTrust}: `missing` when absent, `weak` when a
 * `noreply`/role/shared alias or a shared mailbox, else `trusted`. Pure.
 *
 * @param email the captured email (or undefined)
 * @param shared the source's shared-email set (see {@link sharedEmails})
 * @returns the trust tier + the weak reason (if any)
 */
export function classifyEmailTrust({ email, shared }: { email: string | undefined; shared: ReadonlySet<string> }): {
  trust: EmailTrust;
  reason?: string;
} {
  if (email === undefined || email.length === 0) {
    return { trust: "missing" };
  }
  const weak = weakEmailReason({ email });
  if (weak !== undefined) {
    return { reason: weak, trust: "weak" };
  }
  if (shared.has(normaliseMemberEmail({ email }))) {
    return { reason: "shared-mailbox", trust: "weak" };
  }
  return { trust: "trusted" };
}

/** A member's join email for the resolver — its normalised email ONLY when trusted, else `undefined`. Pure. */
export function trustedJoinEmail({ row }: { row: MemberBronzeRow }): string | undefined {
  return row.identity.emailTrust === "trusted" ? row.identity.emailNormalised : undefined;
}

/**
 * Build a member's curated {@link MemberIdentityFields} from the raw join fields, with a PRELIMINARY trust
 * (pattern-only — the shared-mailbox check needs the whole source, applied later by {@link finaliseMemberTrust}).
 * Pure — a connector calls this per member; the source pass then downgrades any shared address.
 *
 * @param source the identity source
 * @param nativeId the source-native id (the join key within the source)
 * @param handle optional display handle
 * @param name optional display name
 * @param email optional captured email
 * @returns the curated identity projection
 */
export function buildMemberIdentity({
  source,
  nativeId,
  handle,
  name,
  email,
}: {
  source: IdentitySource;
  nativeId: string;
  handle?: string;
  name?: string;
  email?: string;
}): MemberIdentityFields {
  const emailNormalised = email !== undefined ? normaliseMemberEmail({ email }) : undefined;
  const { trust } = classifyEmailTrust({ email, shared: new Set() });
  return {
    emailTrust: trust,
    nativeId,
    source,
    ...(handle !== undefined ? { handle } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(emailNormalised !== undefined ? { emailNormalised } : {}),
  };
}

/**
 * Finalise trust across a source's rows: recompute each email's trust WITH the shared-mailbox set, so an
 * address duplicated across members is downgraded `trusted → weak` (HELD). A downgraded row gains a
 * `shared-mailbox` warning + provenance so the reason is visible. Pure — the whole-source view the
 * per-member {@link buildMemberIdentity} lacked.
 *
 * @param rows one source's hydrated rows
 * @returns the rows with finalised trust (unchanged rows returned as-is)
 */
export function finaliseMemberTrust({ rows }: { rows: readonly MemberBronzeRow[] }): readonly MemberBronzeRow[] {
  const shared = sharedEmails({ rows });
  return rows.map((row) => {
    const { trust, reason } = classifyEmailTrust({ email: row.identity.email, shared });
    if (trust === row.identity.emailTrust) {
      return row;
    }
    const note = `email-${trust}${reason !== undefined ? `:${reason}` : ""}`;
    return {
      ...row,
      identity: { ...row.identity, emailTrust: trust },
      provenance: [...row.provenance, note],
      warnings:
        trust === "weak" ? [...row.warnings, `email held (${reason ?? "weak"}) — not used to auto-link`] : row.warnings,
    };
  });
}
