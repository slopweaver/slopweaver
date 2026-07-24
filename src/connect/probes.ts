/**
 * PRODUCTION probe bags for `connect --check` — the only place a real connector SDK client is constructed
 * for a preflight. Each probe is the CHEAPEST 1-item call for its source, every SDK/GraphQL call wrapped in
 * `safeApiCall` (so a throw becomes a typed error the classifier reads as "unreachable"/"absent", never a
 * crash) and `.map`ped to the small value-only shape the pure classifier consumes. This is the effectful
 * wiring layer (like `productionRefreshDeps`) — the logic it feeds is unit-tested via injected fakes.
 */

import { LinearClient } from "@linear/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Octokit } from "@octokit/rest";
import { WebClient } from "@slack/web-api";

import { isRecord } from "../lib/parsers.js";
import { safeApiCall } from "../lib/safeBoundary.js";
import type { GithubConnectProbes } from "./github.js";
import type { LinearConnectProbes } from "./linear.js";
import type { NotionConnectProbes } from "./notion.js";
import type { SlackConnectProbes } from "./slack.js";

/**
 * How many rows an email-scope/read probe samples. One row is too few to verify a scope (the first member
 * may be a bot with no email even when the scope is granted); a small page makes the human-member signal
 * reliable while staying a cheap, non-blocking single request.
 */
const PROBE_SAMPLE = 25;

/** Count `.nodes` under a top-level GraphQL field (Linear lanes), defensively 0 for any non-array shape. */
function nodeCount({ data, key }: { data: unknown; key: string }): number {
  if (!isRecord(data)) {
    return 0;
  }
  const field = data[key];
  if (isRecord(field) && Array.isArray(field["nodes"])) {
    return field["nodes"].length;
  }
  return 0;
}

/** Whether a Notion user row is a `person` carrying an email (the read-user-email capability signal). */
function notionRowHasEmail({ row }: { row: unknown }): boolean {
  return (
    isRecord(row) && row["type"] === "person" && isRecord(row["person"]) && typeof row["person"]["email"] === "string"
  );
}

/** Whether a Slack member is a HUMAN (not a bot, not deleted) — the population whose emails prove the scope. */
function slackHumanMember({ member }: { member: { is_bot?: boolean; deleted?: boolean } }): boolean {
  return member.is_bot !== true && member.deleted !== true;
}

/** The Slack production probe bag over a live `WebClient` (auth + a sampled member/channel read). */
export function makeSlackConnectProbes({ token }: { token: string }): SlackConnectProbes {
  const client = new WebClient(token);
  return {
    auth: async () =>
      safeApiCall({ execute: () => client.auth.test(), operation: "slack.auth.test", provider: "slack" }).map((r) => ({
        reachable: typeof r.url === "string" && r.url.length > 0,
      })),
    channels: async () =>
      safeApiCall({
        execute: () => client.conversations.list({ limit: 1, types: "public_channel,private_channel" }),
        operation: "slack.conversations.list",
        provider: "slack",
      }).map((r) => ({ sampled: (r.channels ?? []).length })),
    users: async () =>
      safeApiCall({
        execute: () => client.users.list({ limit: PROBE_SAMPLE }),
        operation: "slack.users.list",
        provider: "slack",
      }).map((r) => {
        const members = r.members ?? [];
        const humans = members.filter((m) => slackHumanMember({ member: m }));
        return {
          anyHumanEmail: humans.some((m) => typeof m.profile?.email === "string" && m.profile.email.length > 0),
          humans: humans.length,
          sampled: members.length,
        };
      }),
  };
}

/** The Notion production probe bag (`users.list` = auth + email; a 1-item `search` = read probe). */
export function makeNotionConnectProbes({ token }: { token: string }): NotionConnectProbes {
  const client = new NotionClient({ auth: token });
  return {
    pages: async () =>
      safeApiCall({
        execute: () => client.search({ page_size: 1 }),
        operation: "notion.search",
        provider: "notion",
      }).map((r) => ({ sampled: r.results.length })),
    users: async () =>
      safeApiCall({
        execute: () => client.users.list({ page_size: PROBE_SAMPLE }),
        operation: "notion.users.list",
        provider: "notion",
      }).map((r) => ({
        anyEmail: r.results.some((row) => notionRowHasEmail({ row })),
        anyPerson: r.results.some((row) => isRecord(row) && row["type"] === "person"),
        sampled: r.results.length,
      })),
  };
}

const LINEAR_VIEWER = "query { viewer { id } }";
const LINEAR_ACTIVITY = "query { users(first:1){nodes{id}} issues(first:1){nodes{id}} projects(first:1){nodes{id}} }";
const LINEAR_CURATED = "query { initiatives(first:1){nodes{id}} documents(first:1){nodes{id}} }";

/** The `data` field of a Linear GraphQL `rawRequest` response (unknown until narrowed by the classifier). */
function graphData({ response }: { response: unknown }): unknown {
  return isRecord(response) ? response["data"] : undefined;
}

/** The Linear production probe bag over `rawRequest` (`viewer` auth + a core-lane + a curated-lane sample). */
export function makeLinearConnectProbes({ token }: { token: string }): LinearConnectProbes {
  const client = new LinearClient({ apiKey: token });
  // The one raw GraphQL boundary — wrapped in `safeApiCall` (boundary-residue), mapped to its `data` field.
  const raw = (query: string) =>
    safeApiCall({
      execute: () => client.client.rawRequest(query),
      operation: "linear.rawRequest",
      provider: "linear",
    }).map((response) => graphData({ response }));
  return {
    activity: async () =>
      raw(LINEAR_ACTIVITY).map((d) => ({
        issues: nodeCount({ data: d, key: "issues" }),
        projects: nodeCount({ data: d, key: "projects" }),
        users: nodeCount({ data: d, key: "users" }),
      })),
    curated: async () =>
      raw(LINEAR_CURATED).map((d) => ({
        documents: nodeCount({ data: d, key: "documents" }),
        initiatives: nodeCount({ data: d, key: "initiatives" }),
      })),
    viewer: async () =>
      raw(LINEAR_VIEWER).map((d) => ({
        reachable: isRecord(d) && isRecord(d["viewer"]) && typeof d["viewer"]["id"] === "string",
      })),
  };
}

// Probe the SAME field the ingest SSO-email lane reads (externalIdentities), not just that a provider exists
// — a token can see the provider but be unable to read external identities, so only a readable node counts.
const GITHUB_SAML =
  "query($org:String!){ organization(login:$org){ samlIdentityProvider { externalIdentities(first:1){ nodes { samlIdentity { nameId } } } } } }";

/** Whether the org's SAML `externalIdentities` are READABLE (the actual login→SSO-email join the ingest uses). */
function samlPresent({ data }: { data: unknown }): boolean {
  if (!isRecord(data) || !isRecord(data["organization"])) {
    return false;
  }
  const provider = data["organization"]["samlIdentityProvider"];
  return (
    isRecord(provider) &&
    isRecord(provider["externalIdentities"]) &&
    Array.isArray(provider["externalIdentities"]["nodes"])
  );
}

/** The GitHub production probe bag (1-item repo list = auth + read; team read = read:org; SAML GraphQL). */
export function makeGithubConnectProbes({
  token,
  org,
}: {
  token: string | undefined;
  org: string;
}): GithubConnectProbes {
  const client = new Octokit(token !== undefined ? { auth: token } : {});
  return {
    org: async () =>
      safeApiCall({
        execute: () => client.rest.teams.list({ org, per_page: 1 }),
        operation: "github.teams.list",
        provider: "github",
      }).map(() => ({ teamsReadable: true })),
    repos: async () =>
      safeApiCall({
        execute: () => client.rest.repos.listForOrg({ org, per_page: 1, type: "all" }),
        operation: "github.repos.listForOrg",
        provider: "github",
      }).map((r) => ({ sampled: r.data.length })),
    saml: async () =>
      safeApiCall({
        execute: () => client.graphql(GITHUB_SAML, { org }),
        operation: "github.graphql.saml",
        provider: "github",
      }).map((d) => ({ present: samlPresent({ data: d }) })),
  };
}
