/**
 * Slack preflight: prove `auth.test` reaches the workspace, confirm the token's read breadth (a user token
 * `xoxp` sees every channel; a bot token `xoxb` only invited ones), verify the `users:read.email` scope by
 * sampling one member and checking an email came back, and run a 1-item read probe to catch "token valid
 * but no data visible". The classifier is pure ({@link classifySlack}); the effectful shell awaits the
 * injected probe bag and delegates, so both the probe→field mapping AND the verdicts are unit-tested with
 * plain fake seams (no mocks).
 */
import type { IngestError } from "../lib/ingestError.js";
import type { TypedResult } from "../lib/result.js";
import { type ConnectCapability, type ConnectCheckReport, finaliseReport } from "./types.js";

/**
 * The EXACT Slack user-token scopes the activity + member + structure ingest lanes need. The single source
 * of truth: the bundled app manifest lists these verbatim (a test asserts equality), and the preflight
 * validates the email scope by observing an email on a sampled member.
 */
export const SLACK_REQUIRED_USER_SCOPES: readonly string[] = [
  "users:read",
  "users:read.email",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "files:read",
  "pins:read",
  "bookmarks:read",
  "team:read",
  "usergroups:read",
] as const;

/** The raw, source-agnostic outcome of the Slack probes — the seam output the classifier reads. */
export interface SlackProbe {
  readonly tokenKind: "user" | "bot";
  readonly authReachable: boolean;
  readonly membersSampled: number;
  /** Non-bot, non-deleted members in the sample — the population whose emails prove the scope. */
  readonly humanMembersSampled: number;
  /** Whether a HUMAN member in the sample exposed an email (⇒ `users:read.email` is granted). */
  readonly emailVisible: boolean;
  readonly channelsSampled: number;
}

/**
 * The injectable Slack probe bag. The email-scope probe samples a PAGE (not a single row) and reports the
 * human-member counts, so one non-representative bot/deleted row can't flip the scope verdict either way.
 */
export interface SlackConnectProbes {
  auth(): Promise<TypedResult<{ reachable: boolean }, IngestError>>;
  users(): Promise<TypedResult<{ sampled: number; humans: number; anyHumanEmail: boolean }, IngestError>>;
  channels(): Promise<TypedResult<{ sampled: number }, IngestError>>;
}

/** Build the token-breadth capability from the token kind (user = full; bot = reduced-breadth warning). */
function breadthCapability({ tokenKind }: { tokenKind: "user" | "bot" }): ConnectCapability {
  if (tokenKind === "user") {
    return { detail: "user token (xoxp) — full read breadth", id: "token-breadth", status: "ok" };
  }
  return {
    detail: "bot token (xoxb) — only invited channels; set a user token (xoxp) for full breadth",
    id: "token-breadth",
    status: "warning",
  };
}

/** The `users:read.email` scope verdict: a HUMAN member with an email ⇒ granted; humans but no email ⇒ gap. */
function emailCapability({ probe }: { probe: SlackProbe }): ConnectCapability {
  const id = "scope:users:read.email";
  if (probe.emailVisible) {
    return { detail: "a sampled human member exposed an email — users:read.email is present", id, status: "ok" };
  }
  if (probe.humanMembersSampled > 0) {
    return {
      detail: `${String(probe.humanMembersSampled)} human member(s) sampled, none exposed an email — add the users:read.email scope`,
      id,
      status: "missing",
    };
  }
  return { detail: "no human members visible to verify users:read.email", id, status: "warning" };
}

/** The read-probe verdict: any member/channel visible ⇒ ok; nothing ⇒ a no-data-visible failure. */
function readCapability({ probe }: { probe: SlackProbe }): ConnectCapability {
  if (probe.membersSampled + probe.channelsSampled > 0) {
    return {
      detail: `read probe saw ${String(probe.membersSampled)} member(s), ${String(probe.channelsSampled)} channel(s)`,
      id: "read-probe",
      status: "ok",
    };
  }
  return {
    detail: "auth ok but no members/channels visible — the token cannot read any data",
    id: "read-probe",
    status: "missing",
  };
}

/**
 * Classify a Slack probe into a report. Auth-unreachable short-circuits to a single hard failure; otherwise
 * verdicts on token breadth, the email scope, and the read probe. Pure.
 *
 * @param probe the raw probe outcome
 * @returns the finalised report
 */
export function classifySlack({ probe }: { probe: SlackProbe }): ConnectCheckReport {
  if (!probe.authReachable) {
    return finaliseReport({
      capabilities: [
        {
          detail: "auth.test failed — the token is invalid, revoked, or lacks a valid scope",
          id: "auth",
          status: "missing",
        },
      ],
      errors: ["slack: auth.test did not reach the workspace"],
      source: "slack",
      tokenPresent: true,
    });
  }
  return finaliseReport({
    capabilities: [
      { detail: "auth.test reached the workspace", id: "auth", status: "ok" },
      breadthCapability({ tokenKind: probe.tokenKind }),
      emailCapability({ probe }),
      readCapability({ probe }),
    ],
    source: "slack",
    tokenPresent: true,
  });
}

/**
 * Run the Slack probes and classify. Effectful shell over the injected bag — each probe failure degrades to
 * the safe default (unreachable / zero sampled), never a throw.
 *
 * @param tokenKind whether the resolved read token is a user or bot token
 * @param probes the injected probe bag
 * @returns the preflight report
 */
export async function checkSlackConnection({
  tokenKind,
  probes,
}: {
  tokenKind: "user" | "bot";
  probes: SlackConnectProbes;
}): Promise<ConnectCheckReport> {
  const [auth, users, channels] = await Promise.all([probes.auth(), probes.users(), probes.channels()]);
  const usersOk = users.isOk() ? users.value : { anyHumanEmail: false, humans: 0, sampled: 0 };
  return classifySlack({
    probe: {
      authReachable: auth.isOk() ? auth.value.reachable : false,
      channelsSampled: channels.isOk() ? channels.value.sampled : 0,
      emailVisible: usersOk.anyHumanEmail,
      humanMembersSampled: usersOk.humans,
      membersSampled: usersOk.sampled,
      tokenKind,
    },
  });
}
