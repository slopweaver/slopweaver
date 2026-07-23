/**
 * The Linear STRUCTURE lane: capture the organization (`organization`), its teams, and each team's workflow
 * states + cycles into {@link StructureBronzeRow}s via ONE batched inline GraphQL query per teams-page (each
 * team node carries its members/states/cycles), so structure costs ~1 request/page rather than N. The
 * GraphQL transport is the SAME injected/`safe*`-wrapped, rate-gated, transient-retried seam the activity
 * lane uses; the node parses are pure + separately tested. A malformed node is skipped, never fatal.
 */
import { LinearClient } from "@linear/sdk";
import { isRecord } from "../../lib/parsers.js";
import { createRateScheduler, type RateScheduler, retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import type { AttrValue, StructureBronzeRow, StructureRelation } from "../structures/types.js";
import type { LinearRequest } from "./fetch.js";

const PAGE_SIZE = 50;
/** Well under Linear's ~2,500 req/hr cap (matches the activity lane). */
const LINEAR_RATE_PER_SEC = 0.5;

const ORG_QUERY = `query { organization { id name urlKey userCount samlEnabled } }`;

const TEAMS_QUERY = `
query Teams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes {
      id key name description private
      members { nodes { id } }
      states { nodes { id name type position } }
      cycles { nodes { id number name startsAt endsAt progress } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** A non-empty string field, or undefined. Pure. */
function str({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Project the `organization` object into an `org` structure row. Pure — undefined without an id. */
export function projectLinearOrg({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const id = isRecord(raw) ? str({ value: raw["id"] }) : undefined;
  if (!isRecord(raw) || id === undefined) {
    return undefined;
  }
  const name = str({ value: raw["name"] });
  const urlKey = str({ value: raw["urlKey"] });
  return {
    attrs: {
      ...(typeof raw["userCount"] === "number" ? { userCount: raw["userCount"] } : {}),
      ...(raw["samlEnabled"] === true ? { samlEnabled: true } : {}),
    },
    fetchedAtIso,
    identity: {
      nativeId: id,
      ...(name !== undefined ? { name } : {}),
      ...(urlKey !== undefined ? { slug: urlKey } : {}),
    },
    kind: "org",
    provenance: ["linear.organization"],
    raw,
    relations: [],
    source: "linear",
    sourceId: id,
    version: 1,
    warnings: [],
  };
}

/** The `member` relations off a team node's `members` connection (each a `linear:<userId>` person). Pure. */
function teamMemberRelations({ node }: { node: Record<string, unknown> }): readonly StructureRelation[] {
  const members = isRecord(node["members"]) && Array.isArray(node["members"]["nodes"]) ? node["members"]["nodes"] : [];
  return members
    .map((member) => (isRecord(member) ? str({ value: member["id"] }) : undefined))
    .filter((id): id is string => id !== undefined)
    .map((id) => ({ targetId: `linear:${id}`, targetKind: "person", targetSource: "person", type: "member" }));
}

/** Project one team node into a `team` structure row (with member relations). Pure — undefined without an id. */
export function projectLinearTeam({
  node,
  fetchedAtIso,
}: {
  node: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const id = isRecord(node) ? str({ value: node["id"] }) : undefined;
  if (!isRecord(node) || id === undefined) {
    return undefined;
  }
  const key = str({ value: node["key"] });
  const name = str({ value: node["name"] });
  const description = str({ value: node["description"] });
  return {
    attrs: {
      private: node["private"] === true,
      ...(description !== undefined ? { description } : {}),
    },
    fetchedAtIso,
    identity: { nativeId: id, ...(key !== undefined ? { slug: key } : {}), ...(name !== undefined ? { name } : {}) },
    kind: "team",
    provenance: ["linear.teams"],
    raw: node,
    relations: teamMemberRelations({ node }),
    source: "linear",
    sourceId: id,
    version: 1,
    warnings: [],
  };
}

/** The `state_for` relation binding a state/cycle to its team. Pure. */
function forTeam({ teamId, type }: { teamId: string; type: "state_for" | "cycle_for" }): readonly StructureRelation[] {
  return [{ targetId: teamId, targetKind: "team", targetSource: "linear", type }];
}

/** A builder that turns one validated child node (id + teamId resolved) into a row. */
type ChildRowBuilder = (args: {
  raw: Record<string, unknown>;
  id: string;
  teamId: string;
  fetchedAtIso: string;
}) => StructureBronzeRow;

/**
 * Iterate a team node's `<connectionKey>` nodes, building a row per node that has a defined id (a defined
 * team id is required for the binding relation). Centralises the guard loop so the projectors stay simple. Pure.
 */
function teamChildRows({
  node,
  connectionKey,
  fetchedAtIso,
  build,
}: {
  node: Record<string, unknown>;
  connectionKey: string;
  fetchedAtIso: string;
  build: ChildRowBuilder;
}): readonly StructureBronzeRow[] {
  const teamId = str({ value: node["id"] });
  const conn = node[connectionKey];
  const nodes = isRecord(conn) && Array.isArray(conn["nodes"]) ? conn["nodes"] : [];
  const rows: StructureBronzeRow[] = [];
  for (const raw of nodes) {
    const id = isRecord(raw) ? str({ value: raw["id"] }) : undefined;
    if (isRecord(raw) && id !== undefined && teamId !== undefined) {
      rows.push(build({ fetchedAtIso, id, raw, teamId }));
    }
  }
  return rows;
}

/** Project a team node's workflow states into `workflow_state` rows (each bound to the team). Pure. */
export function projectLinearStates({
  node,
  fetchedAtIso,
}: {
  node: Record<string, unknown>;
  fetchedAtIso: string;
}): readonly StructureBronzeRow[] {
  return teamChildRows({ build: stateRow, connectionKey: "states", fetchedAtIso, node });
}

/** One workflow-state row from a validated raw state node. Pure. */
function stateRow({
  raw,
  id,
  teamId,
  fetchedAtIso,
}: {
  raw: Record<string, unknown>;
  id: string;
  teamId: string;
  fetchedAtIso: string;
}): StructureBronzeRow {
  const name = str({ value: raw["name"] });
  const type = str({ value: raw["type"] });
  const attrs: Record<string, AttrValue> = {
    ...(type !== undefined ? { type } : {}),
    ...(typeof raw["position"] === "number" ? { position: raw["position"] } : {}),
  };
  return {
    attrs,
    fetchedAtIso,
    identity: { nativeId: id, ...(name !== undefined ? { name } : {}) },
    kind: "workflow_state",
    provenance: ["linear.teams.states"],
    raw,
    relations: forTeam({ teamId, type: "state_for" }),
    source: "linear",
    sourceId: id,
    version: 1,
    warnings: [],
  };
}

/** Project a team node's cycles into `cycle` rows (each bound to the team). Pure. */
export function projectLinearCycles({
  node,
  fetchedAtIso,
}: {
  node: Record<string, unknown>;
  fetchedAtIso: string;
}): readonly StructureBronzeRow[] {
  return teamChildRows({ build: cycleRow, connectionKey: "cycles", fetchedAtIso, node });
}

/** One cycle row from a validated raw cycle node. Pure. */
function cycleRow({
  raw,
  id,
  teamId,
  fetchedAtIso,
}: {
  raw: Record<string, unknown>;
  id: string;
  teamId: string;
  fetchedAtIso: string;
}): StructureBronzeRow {
  const name = str({ value: raw["name"] });
  const startsAt = str({ value: raw["startsAt"] });
  const endsAt = str({ value: raw["endsAt"] });
  const attrs: Record<string, AttrValue> = {
    ...(typeof raw["number"] === "number" ? { number: raw["number"] } : {}),
    ...(typeof raw["progress"] === "number" ? { progress: raw["progress"] } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
  };
  return {
    attrs,
    fetchedAtIso,
    identity: { nativeId: id, ...(name !== undefined ? { name } : {}) },
    kind: "cycle",
    provenance: ["linear.teams.cycles"],
    raw,
    relations: forTeam({ teamId, type: "cycle_for" }),
    source: "linear",
    sourceId: id,
    version: 1,
    warnings: [],
  };
}

/** The pageInfo `{ hasNext, endCursor }` off a connection. Pure. */
function pageInfoOf({ connection }: { connection: unknown }): { hasNext: boolean; endCursor?: string } {
  const info = isRecord(connection) ? connection["pageInfo"] : undefined;
  if (!isRecord(info)) {
    return { hasNext: false };
  }
  const endCursor = str({ value: info["endCursor"] });
  return { hasNext: info["hasNextPage"] === true, ...(endCursor !== undefined ? { endCursor } : {}) };
}

/** Every structure row off one raw teams-page (team + its states + cycles). Pure. */
export function structuresFromTeamsPage({ data, fetchedAtIso }: { data: unknown; fetchedAtIso: string }): {
  rows: readonly StructureBronzeRow[];
  nextCursor?: string;
} {
  const connection = isRecord(data) ? data["teams"] : undefined;
  const nodes = isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const rows: StructureBronzeRow[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const team = projectLinearTeam({ fetchedAtIso, node });
    if (team !== undefined) {
      rows.push(team);
    }
    rows.push(...projectLinearStates({ fetchedAtIso, node }), ...projectLinearCycles({ fetchedAtIso, node }));
  }
  const info = pageInfoOf({ connection });
  return { rows, ...(info.hasNext && info.endCursor !== undefined ? { nextCursor: info.endCursor } : {}) };
}

/**
 * Hydrate the Linear org structure: the organization row plus every team (+ its states + cycles), paging the
 * teams lane to exhaustion. A failure is fatal (`err`) after the transport's retry budget.
 *
 * @param request the injected GraphQL transport (rate-gated + retried in production)
 * @param fetchedAtIso the hydration timestamp
 * @returns the structure rows + warnings, or `err` on a fatal failure
 */
export async function fetchLinearStructures({
  request,
  fetchedAtIso,
}: {
  request: LinearRequest;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }>> {
  const rows: StructureBronzeRow[] = [];
  try {
    const orgData = await request({ query: ORG_QUERY, variables: {} });
    const orgRow = projectLinearOrg({ fetchedAtIso, raw: isRecord(orgData) ? orgData["organization"] : undefined });
    if (orgRow !== undefined) {
      rows.push(orgRow);
    }
    let cursor: string | undefined;
    do {
      const data = await request({
        query: TEAMS_QUERY,
        variables: { first: PAGE_SIZE, ...(cursor !== undefined ? { after: cursor } : {}) },
      });
      const page = structuresFromTeamsPage({ data, fetchedAtIso });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return err([`linear structure hydration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  return ok({ rows, warnings: [] });
}

/**
 * Build the production Linear structure transport — the SAME rate-gated, transient-retried, `safe*`-wrapped
 * `rawRequest` seam the activity lane uses (retry OUTSIDE the gate so a post-429 retry re-acquires a slot).
 *
 * @param token the Linear API key
 * @param scheduler an injected rate scheduler (defaults to one under Linear's cap)
 * @returns the live GraphQL transport
 */
export function makeLinearStructuresRequest({
  token,
  scheduler,
}: {
  token: string;
  scheduler?: RateScheduler;
}): LinearRequest {
  const client = new LinearClient({ apiKey: token });
  const gate = scheduler ?? createRateScheduler({ ratePerSec: LINEAR_RATE_PER_SEC });
  const send: LinearRequest = async ({ query, variables }) => {
    const res = orThrow({
      result: await safeApiCall({
        execute: () => client.client.rawRequest(query, variables),
        operation: "linear.rawRequest",
        provider: "linear",
      }),
    });
    return res.data;
  };
  return ({ query, variables }) => retryTransient({ operation: () => gate(() => send({ query, variables })) });
}
