/**
 * The GitHub member lane: enumerate an org's members (`orgs.listMembers`), enrich each with their public
 * profile (`users.getByUsername`), and — when the org is SAML-backed and the token is org-admin — join each
 * login to its SSO email via `organization.samlIdentityProvider.externalIdentities` (GraphQL). Public GitHub
 * profile email is usually null and SAML is capability-gated, so a member with no resolvable email is HELD
 * (a warning, `missing` trust), never linked from login/name — data-first (D8), no guessed cross-source edges.
 *
 * The network is an injected {@link GithubMembersApi} seam so the orchestration is unit-tested with a fake;
 * the live seam (built once here) routes every SDK/GraphQL call through a `safe*` wrapper.
 */
import { isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import { buildMemberIdentity, finaliseMemberTrust } from "../members/email.js";
import { aggregateMemberWarnings } from "../members/project.js";
import type { MemberBronzeRow } from "../members/types.js";
import { type GithubClient, makeGithubClient } from "./fetch.js";

const PER_PAGE = 100;
const MAX_PAGES = 20;

/** The injected GitHub member seam. `getUser` is per-member (non-fatal); `samlEmails` may be a capability gap. */
export interface GithubMembersApi {
  listMembers: (args: { org: string; page: number }) => Promise<readonly unknown[]>;
  getUser: (args: { username: string }) => Promise<unknown | undefined>;
  samlEmails: (args: { org: string }) => Promise<Result<ReadonlyMap<string, string>>>;
}

/** A non-empty string off a raw object, else undefined. */
function ghStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Project a GitHub member (its `listMembers` stub merged with its `getUser` profile, plus any SAML email)
 * into a {@link MemberBronzeRow}. The SAML SSO email wins over the public profile email. The raw stored is
 * the richest object available (profile ?? stub). Pure — undefined when there's no login.
 *
 * @param stub the raw `listMembers` entry (carries the login)
 * @param profile the raw `users.getByUsername` object, when the enrichment succeeded
 * @param samlEmail the SSO email for this login, when a SAML join resolved one
 * @param fetchedAtIso the hydration timestamp
 * @returns the member row, or `undefined`
 */
export function projectGithubMember({
  stub,
  profile,
  samlEmail,
  fetchedAtIso,
}: {
  stub: unknown;
  profile?: unknown;
  samlEmail?: string;
  fetchedAtIso: string;
}): MemberBronzeRow | undefined {
  const login = isRecord(stub) ? ghStr({ value: stub["login"] }) : undefined;
  if (login === undefined) {
    return undefined;
  }
  // A GitHub member is assembled from TWO calls, so its FULL raw is the composite — the `listMembers` stub
  // AND the `getByUsername` profile, both kept (nothing projected away). The richer profile drives the
  // curated fields, but the org-membership stub can carry fields the profile lacks, so it is retained too.
  const record = isRecord(profile) ? profile : isRecord(stub) ? stub : {};
  const email = samlEmail ?? ghStr({ value: record["email"] });
  const name = ghStr({ value: record["name"] });
  const avatarUrl = ghStr({ value: record["avatar_url"] });
  return {
    fetchedAtIso,
    identity: buildMemberIdentity({
      handle: login,
      nativeId: login,
      source: "github",
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    }),
    profile: { bot: record["type"] === "Bot", ...(avatarUrl !== undefined ? { avatarUrl } : {}) },
    provenance: samlEmail !== undefined ? ["github.orgs.listMembers", "github.saml"] : ["github.orgs.listMembers"],
    raw: { listMember: stub, ...(profile !== undefined ? { profile } : {}) },
    source: "github",
    sourceId: login,
    version: 1,
    warnings: email === undefined ? ["no email — GitHub public profile empty and no SAML SSO email resolved"] : [],
  };
}

/** Page an org's member logins to exhaustion (bounded by the hard page cap). */
async function listAllMembers({ api, org }: { api: GithubMembersApi; org: string }): Promise<readonly unknown[]> {
  const members: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api.listMembers({ org, page });
    members.push(...batch);
    if (batch.length < PER_PAGE) {
      break;
    }
  }
  return members;
}

/**
 * Hydrate an org's members: enumerate, enrich each with its profile, join SAML emails, finalise trust. A
 * `listMembers` failure is fatal (`err`); a missing SAML capability is a warning + login/public-email only.
 *
 * @param api the injected member seam
 * @param org the GitHub org login (the repo owner)
 * @param fetchedAtIso the hydration timestamp
 * @returns the member rows + warnings, or `err` on a fatal enumeration failure
 */
export async function fetchGithubMembers({
  api,
  org,
  fetchedAtIso,
}: {
  api: GithubMembersApi;
  org: string;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly MemberBronzeRow[]; warnings: readonly string[] }>> {
  let stubs: readonly unknown[];
  try {
    stubs = await listAllMembers({ api, org });
  } catch (error: unknown) {
    return err([`github member enumeration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const saml = await api.samlEmails({ org });
  const samlMap = saml.ok ? saml.value : new Map<string, string>();
  const warnings: string[] = saml.ok ? [] : [...saml.errors];
  const rows = await enrichMembers({ api, fetchedAtIso, samlMap, stubs });
  const finalised = finaliseMemberTrust({ rows });
  return ok({ rows: finalised, warnings: [...warnings, ...aggregateMemberWarnings({ rows: finalised })] });
}

/** Enrich each member stub with its profile (per-member failures swallowed) + its SAML email. */
async function enrichMembers({
  api,
  stubs,
  samlMap,
  fetchedAtIso,
}: {
  api: GithubMembersApi;
  stubs: readonly unknown[];
  samlMap: ReadonlyMap<string, string>;
  fetchedAtIso: string;
}): Promise<MemberBronzeRow[]> {
  const rows: MemberBronzeRow[] = [];
  for (const stub of stubs) {
    const row = await enrichOne({ api, fetchedAtIso, samlMap, stub });
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return rows;
}

/** Enrich ONE member stub with its profile + SAML email into a row (undefined when it has no login). */
async function enrichOne({
  api,
  stub,
  samlMap,
  fetchedAtIso,
}: {
  api: GithubMembersApi;
  stub: unknown;
  samlMap: ReadonlyMap<string, string>;
  fetchedAtIso: string;
}): Promise<MemberBronzeRow | undefined> {
  const login = isRecord(stub) ? ghStr({ value: stub["login"] }) : undefined;
  if (login === undefined) {
    return projectGithubMember({ fetchedAtIso, stub });
  }
  const profile = await api.getUser({ username: login });
  const samlEmail = samlMap.get(login);
  return projectGithubMember({
    fetchedAtIso,
    stub,
    ...(profile !== undefined ? { profile } : {}),
    ...(samlEmail !== undefined ? { samlEmail } : {}),
  });
}

const SAML_QUERY = `query($org:String!,$after:String){
  organization(login:$org){
    samlIdentityProvider{
      externalIdentities(first:100,after:$after){
        pageInfo{hasNextPage endCursor}
        nodes{samlIdentity{nameId} user{login}}
      }
    }
  }
}`;

/** The `login → SSO email` map from one SAML GraphQL page, plus the next cursor. Pure. */
export function parseSamlPage({ data }: { data: unknown }): {
  pairs: readonly (readonly [string, string])[];
  nextCursor?: string;
  hasProvider: boolean;
} {
  const org = isRecord(data) ? data["organization"] : undefined;
  const provider = isRecord(org) ? org["samlIdentityProvider"] : undefined;
  if (!isRecord(provider)) {
    return { hasProvider: false, pairs: [] };
  }
  const conn = isRecord(provider["externalIdentities"]) ? provider["externalIdentities"] : {};
  const nodes = Array.isArray(conn["nodes"]) ? conn["nodes"] : [];
  const pairs = nodes.flatMap((node) => samlPair({ node }));
  const info = isRecord(conn["pageInfo"]) ? conn["pageInfo"] : {};
  const endCursor = ghStr({ value: info["endCursor"] });
  return {
    hasProvider: true,
    pairs,
    ...(info["hasNextPage"] === true && endCursor !== undefined ? { nextCursor: endCursor } : {}),
  };
}

/** The `[login, nameId-email]` pair off one external-identity node (empty when either side is missing). Pure. */
function samlPair({ node }: { node: unknown }): readonly (readonly [string, string])[] {
  if (!isRecord(node)) {
    return [];
  }
  const login = isRecord(node["user"]) ? ghStr({ value: node["user"]["login"] }) : undefined;
  const nameId = isRecord(node["samlIdentity"]) ? ghStr({ value: node["samlIdentity"]["nameId"] }) : undefined;
  return login !== undefined && nameId !== undefined ? [[login, nameId]] : [];
}

/** The injected GraphQL transport (throws on error). */
type GithubGraphql = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/** Page the SAML external identities into a `login → email` map, or `err` when the org isn't SAML-backed. */
async function collectSamlEmails({
  graphql,
  org,
}: {
  graphql: GithubGraphql;
  org: string;
}): Promise<Result<ReadonlyMap<string, string>>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  try {
    do {
      const data = await graphql(SAML_QUERY, { org, ...(cursor !== undefined ? { after: cursor } : {}) });
      const page = parseSamlPage({ data });
      if (!page.hasProvider) {
        return err([
          "github: no SAML external identities (needs an org-admin token + a SAML org) — emails limited to public profile",
        ]);
      }
      for (const [login, email] of page.pairs) {
        map.set(login, email);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } catch (error: unknown) {
    return err([
      `github: SAML email lookup unavailable (${error instanceof Error ? error.message : "unknown"}) — emails limited to public profile`,
    ]);
  }
  return ok(map);
}

/**
 * Build the production GitHub member seam over a resilient octokit client. Every SDK/GraphQL call is routed
 * through a `safe*` wrapper (typed error); pagination reuses octokit's built-in retry/throttle plugins.
 *
 * @param token the GitHub token (org-admin + `read:org` needed for SAML emails)
 * @returns the live member seam
 */
export function makeGithubMembersApi({ token }: { token: string | undefined }): GithubMembersApi {
  const client = makeGithubClient({ token });
  return {
    getUser: ({ username }) => getUserSafe({ client, username }),
    listMembers: async ({ org, page }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () => client.rest.orgs.listMembers({ org, page, per_page: PER_PAGE }),
          operation: "github.orgs.listMembers",
          provider: "github",
        }),
      });
      return res.data;
    },
    samlEmails: ({ org }) => collectSamlEmails({ graphql: safeGraphql({ client }), org }),
  };
}

/** The SAML GraphQL transport, routed through `safeApiCall` (typed error) then re-thrown so the
 * capability-gap policy in {@link collectSamlEmails} (err → warning) runs unchanged. */
function safeGraphql({ client }: { client: GithubClient }): GithubGraphql {
  return async (query, variables) =>
    orThrow({
      result: await safeApiCall({
        execute: () => client.graphql(query, variables),
        operation: "github.graphql.samlIdentities",
        provider: "github",
      }),
    });
}

/** One `users.getByUsername` call — non-fatal (a 404/blocked profile yields `undefined`, not a throw). */
async function getUserSafe({
  client,
  username,
}: {
  client: GithubClient;
  username: string;
}): Promise<unknown | undefined> {
  const res = await safeApiCall({
    execute: () => client.rest.users.getByUsername({ username }),
    operation: "github.users.getByUsername",
    provider: "github",
  });
  return res.isOk() ? res.value.data : undefined;
}
