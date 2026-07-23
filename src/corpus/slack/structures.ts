/**
 * The Slack STRUCTURE lane: capture the workspace/enterprise (`auth.test` + `team.info`), every channel's
 * metadata (topic/purpose/created/creator/flags — already carried on the `conversations.list` objects, so no
 * per-channel `conversations.info` is needed), channel MEMBERSHIP (`conversations.members`, the one N-call
 * risk — bounded by a cap + archived-skip + logged), and usergroups (`usergroups.list` with inline users)
 * into {@link StructureBronzeRow}s. Every SDK call is a `safe*`-wrapped, injected seam so it's unit-tested
 * with a fake; membership is deliberately bounded so "all my channels" never becomes a thundering herd.
 */
import { WebClient } from "@slack/web-api";
import { isRecord } from "../../lib/parsers.js";
import { retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import type { AttrValue, StructureBronzeRow, StructureRelation } from "../structures/types.js";

const PAGE_LIMIT = 200;
/** Default max channels to resolve MEMBERSHIP for — the per-channel `conversations.members` scale guard. */
export const DEFAULT_MEMBERSHIP_CAP = 50;

/** The injected Slack structure seam — raw shapes stay `unknown`, parsed defensively by the projectors. */
export interface SlackStructuresApi {
  authTest: () => Promise<unknown>;
  teamInfo: () => Promise<unknown>;
  listChannels: (args: { cursor?: string }) => Promise<{ channels: readonly unknown[]; nextCursor?: string }>;
  channelMembers: (args: { channel: string }) => Promise<readonly string[]>;
  listUsergroups: () => Promise<readonly unknown[]>;
}

/** A non-empty string off a raw object, else undefined. Pure. */
function slStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The `topic`/`purpose` value string off a Slack channel sub-object (`{ value }`). Pure. */
function nestedValue({ field }: { field: unknown }): string | undefined {
  return isRecord(field) ? slStr({ value: field["value"] }) : undefined;
}

/**
 * Project the workspace (`team.info` + `auth.test`) into an `org` structure row. Pure — undefined without a
 * team id. Enterprise id/name (Enterprise Grid) come from `auth.test` when present.
 *
 * @param team the raw `team.info` team object
 * @param auth the raw `auth.test` response (for enterprise fields)
 * @param fetchedAtIso the hydration timestamp
 * @returns the workspace row, or `undefined`
 */
export function projectWorkspaceRow({
  team,
  auth,
  fetchedAtIso,
}: {
  team: unknown;
  auth: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const id = isRecord(team) ? slStr({ value: team["id"] }) : undefined;
  if (!isRecord(team) || id === undefined) {
    return undefined;
  }
  const name = slStr({ value: team["name"] });
  const domain = slStr({ value: team["domain"] });
  const enterpriseId = isRecord(auth) ? slStr({ value: auth["enterprise_id"] }) : undefined;
  const enterpriseName = isRecord(auth) ? slStr({ value: auth["enterprise_name"] }) : undefined;
  return {
    attrs: {
      ...(enterpriseId !== undefined ? { enterpriseId } : {}),
      ...(enterpriseName !== undefined ? { enterpriseName } : {}),
    },
    fetchedAtIso,
    identity: {
      nativeId: id,
      ...(name !== undefined ? { name } : {}),
      ...(domain !== undefined ? { slug: domain } : {}),
      ...(domain !== undefined ? { url: `https://${domain}.slack.com` } : {}),
    },
    kind: "org",
    provenance: ["slack.team.info"],
    raw: { auth, team },
    relations: [],
    source: "slack",
    sourceId: id,
    version: 1,
    warnings: [],
  };
}

/** The `member` relations off a channel's resolved member ids (each a `slack:<userId>` person). Pure. */
function memberRelations({ memberIds }: { memberIds: readonly string[] }): readonly StructureRelation[] {
  return memberIds.map((userId) => ({
    targetId: `slack:${userId}`,
    targetKind: "person",
    targetSource: "person",
    type: "member",
  }));
}

/**
 * Project one raw `conversations.list` channel object into a `channel` structure row, attaching any resolved
 * member relations. Pure — undefined without a channel id. Membership stays empty when it wasn't fetched
 * (a `membership-not-fetched` warning is added so the gap is explicit, never mistaken for "no members").
 *
 * @param raw the raw channel object
 * @param memberIds the resolved member ids (empty when membership wasn't fetched — see `membershipFetched`)
 * @param membershipFetched whether membership was actually fetched for this channel
 * @param fetchedAtIso the hydration timestamp
 * @returns the channel row, or `undefined`
 */
export function projectChannelRow({
  raw,
  memberIds,
  membershipFetched,
  fetchedAtIso,
}: {
  raw: unknown;
  memberIds: readonly string[];
  membershipFetched: boolean;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const id = isRecord(raw) ? slStr({ value: raw["id"] }) : undefined;
  if (!isRecord(raw) || id === undefined) {
    return undefined;
  }
  const name = slStr({ value: raw["name"] });
  const topic = nestedValue({ field: raw["topic"] });
  const purpose = nestedValue({ field: raw["purpose"] });
  const creator = slStr({ value: raw["creator"] });
  const attrs: Record<string, AttrValue> = {
    archived: raw["is_archived"] === true,
    private: raw["is_private"] === true,
    ...(topic !== undefined ? { topic } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(typeof raw["num_members"] === "number" ? { numMembers: raw["num_members"] } : {}),
    ...(typeof raw["created"] === "number" ? { created: raw["created"] } : {}),
  };
  return {
    attrs,
    fetchedAtIso,
    identity: { nativeId: id, ...(name !== undefined ? { name } : {}) },
    kind: "channel",
    provenance: ["slack.conversations.list", ...(membershipFetched ? ["slack.conversations.members"] : [])],
    raw,
    relations: memberRelations({ memberIds }),
    source: "slack",
    sourceId: id,
    version: 1,
    warnings: membershipFetched ? [] : ["membership not fetched (archived or past the membership cap)"],
  };
}

/** Project one raw usergroup (`usergroups.list` with inline `users`) into a `usergroup` row. Pure. */
export function projectUsergroupRow({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const id = isRecord(raw) ? slStr({ value: raw["id"] }) : undefined;
  if (!isRecord(raw) || id === undefined) {
    return undefined;
  }
  const name = slStr({ value: raw["name"] });
  const handle = slStr({ value: raw["handle"] });
  const users = Array.isArray(raw["users"]) ? raw["users"].filter((u): u is string => typeof u === "string") : [];
  return {
    attrs: {},
    fetchedAtIso,
    identity: {
      nativeId: id,
      ...(name !== undefined ? { name } : {}),
      ...(handle !== undefined ? { slug: handle } : {}),
    },
    kind: "usergroup",
    provenance: ["slack.usergroups.list"],
    raw,
    relations: memberRelations({ memberIds: users }),
    source: "slack",
    sourceId: id,
    version: 1,
    warnings: [],
  };
}

/** The channel id + whether membership should be fetched for it. */
interface ChannelPlanEntry {
  readonly raw: unknown;
  readonly id: string;
  readonly fetchMembership: boolean;
}

/** The membership plan: which channels get a `conversations.members` call + the skip warning. */
export interface ChannelMembershipPlan {
  readonly entries: readonly ChannelPlanEntry[];
  readonly warnings: readonly string[];
}

/**
 * Plan channel membership: archived channels never get a membership call, and only the first `cap` ACTIVE
 * channels do (the per-channel `conversations.members` scale guard). Every skipped active channel is logged —
 * never silently dropped. Pure.
 *
 * @param channels the raw discovered channels (discovery order)
 * @param cap the max active channels to resolve membership for
 * @returns the per-channel plan + the skip warning
 */
export function planChannelMembership({
  channels,
  cap,
}: {
  channels: readonly unknown[];
  cap: number;
}): ChannelMembershipPlan {
  let activeFetched = 0;
  const entries: ChannelPlanEntry[] = [];
  let skipped = 0;
  for (const raw of channels) {
    const id = isRecord(raw) ? slStr({ value: raw["id"] }) : undefined;
    if (id === undefined) {
      continue;
    }
    const archived = isRecord(raw) && raw["is_archived"] === true;
    const canFetch = !archived && activeFetched < cap;
    if (canFetch) {
      activeFetched += 1;
    } else if (!archived) {
      skipped += 1;
    }
    entries.push({ fetchMembership: canFetch, id, raw });
  }
  const warnings =
    skipped > 0
      ? [`slack: channel-membership cap ${String(cap)} applied — ${String(skipped)} active channel(s) not resolved`]
      : [];
  return { entries, warnings };
}

/** Build every channel row, fetching membership only for planned channels (a per-channel failure warns). */
async function buildChannelRows({
  api,
  plan,
  fetchedAtIso,
}: {
  api: SlackStructuresApi;
  plan: ChannelMembershipPlan;
  fetchedAtIso: string;
}): Promise<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }> {
  const rows: StructureBronzeRow[] = [];
  const warnings: string[] = [];
  for (const entry of plan.entries) {
    let memberIds: readonly string[] = [];
    if (entry.fetchMembership) {
      try {
        memberIds = await api.channelMembers({ channel: entry.id });
      } catch (error: unknown) {
        warnings.push(`slack channel ${entry.id} members: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    const row = projectChannelRow({
      fetchedAtIso,
      memberIds,
      membershipFetched: entry.fetchMembership,
      raw: entry.raw,
    });
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return { rows, warnings };
}

/** Page every channel from the seam to exhaustion. */
async function discoverChannels({ api }: { api: SlackStructuresApi }): Promise<readonly unknown[]> {
  const channels: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listChannels(cursor !== undefined ? { cursor } : {});
    channels.push(...page.channels);
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);
  return channels;
}

/**
 * Hydrate the Slack workspace structure: the workspace/enterprise row, every channel (metadata + capped
 * membership), and usergroups. A workspace-discovery failure is fatal (`err`); a usergroups gap degrades to
 * a warning.
 *
 * @param api the injected Slack structure seam
 * @param membershipCap the max active channels to resolve membership for
 * @param fetchedAtIso the hydration timestamp
 * @returns the structure rows + warnings, or `err` on a fatal discovery failure
 */
export async function fetchSlackStructures({
  api,
  membershipCap,
  fetchedAtIso,
}: {
  api: SlackStructuresApi;
  membershipCap: number;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }>> {
  let channels: readonly unknown[];
  let workspaceRow: StructureBronzeRow | undefined;
  try {
    const auth = await api.authTest();
    const team = await api.teamInfo();
    workspaceRow = projectWorkspaceRow({ auth, fetchedAtIso, team });
    channels = await discoverChannels({ api });
  } catch (error: unknown) {
    return err([`slack structure discovery failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const plan = planChannelMembership({ cap: membershipCap, channels });
  const channelRows = await buildChannelRows({ api, fetchedAtIso, plan });
  const usergroups = await hydrateUsergroups({ api, fetchedAtIso });
  return ok({
    rows: [...(workspaceRow !== undefined ? [workspaceRow] : []), ...channelRows.rows, ...usergroups.rows],
    warnings: [...plan.warnings, ...channelRows.warnings, ...usergroups.warnings],
  });
}

/** Fetch + project usergroups; a scope gap degrades to a warning (no rows). */
async function hydrateUsergroups({
  api,
  fetchedAtIso,
}: {
  api: SlackStructuresApi;
  fetchedAtIso: string;
}): Promise<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }> {
  try {
    const groups = await api.listUsergroups();
    const rows = groups
      .map((raw) => projectUsergroupRow({ fetchedAtIso, raw }))
      .filter((row): row is StructureBronzeRow => row !== undefined);
    return { rows, warnings: [] };
  } catch (error: unknown) {
    return {
      rows: [],
      warnings: [`slack usergroups unavailable: ${error instanceof Error ? error.message : "unknown"}`],
    };
  }
}

/** The `nextCursor` off a Slack `response_metadata` — absent/empty ⇒ stop paging. Pure. */
function nextCursorOf({ metadata }: { metadata: { next_cursor?: string } | undefined }): string | undefined {
  return metadata?.next_cursor !== undefined && metadata.next_cursor.length > 0 ? metadata.next_cursor : undefined;
}

/**
 * Build the production Slack structure seam over a live `WebClient`. Every SDK call is transient-retried and
 * routed through a `safe*` wrapper (typed error) then re-thrown, so the orchestrator's fatal/degrade policy
 * runs unchanged. `conversations.members` is paged to exhaustion PER planned channel.
 *
 * @param token the Slack read token
 * @returns the live Slack structure seam
 */
export function makeSlackStructuresApi({ token }: { token: string }): SlackStructuresApi {
  const client = new WebClient(token);
  return {
    authTest: async () =>
      orThrow({
        result: await safeApiCall({
          execute: () => retryTransient({ operation: () => client.auth.test() }),
          operation: "slack.auth.test",
          provider: "slack",
        }),
      }),
    channelMembers: ({ channel }) => channelMembersAll({ channel, client }),
    listChannels: async ({ cursor }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            retryTransient({
              operation: () =>
                client.conversations.list({
                  exclude_archived: false,
                  limit: PAGE_LIMIT,
                  types: "public_channel,private_channel",
                  ...(cursor !== undefined ? { cursor } : {}),
                }),
            }),
          operation: "slack.conversations.list",
          provider: "slack",
        }),
      });
      const next = nextCursorOf({ metadata: res.response_metadata });
      return { channels: res.channels ?? [], ...(next !== undefined ? { nextCursor: next } : {}) };
    },
    listUsergroups: async () => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () => retryTransient({ operation: () => client.usergroups.list({ include_users: true }) }),
          operation: "slack.usergroups.list",
          provider: "slack",
        }),
      });
      return res.usergroups ?? [];
    },
    teamInfo: async () => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () => retryTransient({ operation: () => client.team.info() }),
          operation: "slack.team.info",
          provider: "slack",
        }),
      });
      return res.team;
    },
  };
}

/** Page one channel's members to exhaustion (`conversations.members`), each page safe-wrapped. */
async function channelMembersAll({
  client,
  channel,
}: {
  client: WebClient;
  channel: string;
}): Promise<readonly string[]> {
  const members: string[] = [];
  let cursor: string | undefined;
  do {
    const res = orThrow({
      result: await safeApiCall({
        execute: () =>
          retryTransient({
            operation: () =>
              client.conversations.members({ channel, limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) }),
          }),
        operation: "slack.conversations.members",
        provider: "slack",
      }),
    });
    members.push(...(res.members ?? []));
    cursor = nextCursorOf({ metadata: res.response_metadata });
  } while (cursor !== undefined && cursor.length > 0);
  return members;
}
