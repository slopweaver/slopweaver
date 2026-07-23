/**
 * The GitHub ORG lane: enumerate the org itself (`orgs.get`), all its repos (`repos.listForOrg`, paged +
 * include/exclude/cap filtered), and its teams (`teams.list` → per-team members + repo permissions) into
 * durable {@link StructureBronzeRow}s. `read:org` gates teams/private repos, so a teams failure DEGRADES to a
 * warning (org + public repos still land) rather than crashing the refresh — data-first (D8), no invented
 * structure. The network is an injected {@link GithubOrgApi} seam (unit-tested with a fake); the live seam
 * routes every SDK call through a `safe*` wrapper and reuses octokit's own retry/throttle plugins.
 */
import type { Repository } from "../../config.js";
import { isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import type { AttrValue, StructureBronzeRow, StructureRelation } from "../structures/types.js";
import { type GithubClient, makeGithubClient } from "./fetch.js";

const PER_PAGE = 100;
const MAX_PAGES = 20;

/** The injected GitHub org seam. `getOrg` is non-fatal; `listTeams` returns `err` on a `read:org` scope gap. */
export interface GithubOrgApi {
  getOrg: (args: { org: string }) => Promise<unknown | undefined>;
  listRepos: (args: { org: string; page: number }) => Promise<readonly unknown[]>;
  listTeams: (args: { org: string }) => Promise<Result<readonly unknown[]>>;
  listTeamMembers: (args: { org: string; teamSlug: string }) => Promise<readonly unknown[]>;
  listTeamRepos: (args: { org: string; teamSlug: string }) => Promise<readonly unknown[]>;
}

/** A non-empty string off a raw object, else undefined. Pure. */
function ghStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Compile a repo glob (`app-*`, `*-archive`) into an anchored RegExp — `*` matches any run, `?` one char,
 * every other character is literal. Pure — the tiny glob surface repo-selection needs (no brace/range).
 *
 * @param glob the glob pattern
 * @returns an anchored RegExp matching the whole repo name
 */
export function globToRegExp({ glob }: { glob: string }): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** Whether a name matches any of the globs (empty list ⇒ false). Pure. */
function matchesAny({ name, globs }: { name: string; globs: readonly string[] }): boolean {
  return globs.some((glob) => globToRegExp({ glob }).test(name));
}

/** The outcome of applying include/exclude/cap to the enumerated repo names. */
export interface RepoSelection {
  readonly selected: readonly string[];
  readonly excluded: readonly string[];
  readonly cappedCount: number;
  readonly warnings: readonly string[];
}

/**
 * Select which repo names to ingest: keep those matching an `include` glob (empty include ⇒ all), drop any
 * matching an `exclude` glob, sort, then apply `cap`. Every drop/cap is reported — never silent. Pure.
 *
 * @param names the enumerated repo names
 * @param include include globs (empty ⇒ all repos)
 * @param exclude exclude globs
 * @param cap the max repos to keep (undefined ⇒ no cap)
 * @returns the selected names + what was excluded/capped + warnings
 */
export function selectRepoNames({
  names,
  include,
  exclude,
  cap,
}: {
  names: readonly string[];
  include: readonly string[];
  exclude: readonly string[];
  cap: number | undefined;
}): RepoSelection {
  const included = include.length > 0 ? names.filter((name) => matchesAny({ globs: include, name })) : [...names];
  const excluded = included.filter((name) => matchesAny({ globs: exclude, name })).toSorted();
  const kept = included.filter((name) => !matchesAny({ globs: exclude, name })).toSorted();
  const capped = cap !== undefined && kept.length > cap ? kept.length - cap : 0;
  const selected = capped > 0 && cap !== undefined ? kept.slice(0, cap) : kept;
  const filteredOut = include.length > 0 ? names.length - included.length : 0;
  // Every skip is surfaced (never silent): the include filter, the exclude globs, and the cap all log.
  const warnings = [
    ...(filteredOut > 0
      ? [`github: ${String(filteredOut)} repo(s) filtered out by --include-repo (${String(included.length)} matched)`]
      : []),
    ...(excluded.length > 0 ? [`github: ${String(excluded.length)} repo(s) skipped by --exclude-repo`] : []),
    ...(capped > 0
      ? [`github: repo cap ${String(cap)} applied — ${String(capped)} of ${String(kept.length)} repo(s) skipped`]
      : []),
  ];
  return { cappedCount: capped, excluded, selected, warnings };
}

/** Compose an org attrs entry only when the value is present (drops undefined). Pure. */
function optAttr({ key, value }: { key: string; value: AttrValue | undefined }): Readonly<Record<string, AttrValue>> {
  return value !== undefined ? { [key]: value } : {};
}

/** Project the org object (`orgs.get`) into an `org` structure row. Pure — undefined without a login. */
export function projectOrgRow({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const login = isRecord(raw) ? ghStr({ value: raw["login"] }) : undefined;
  if (!isRecord(raw) || login === undefined) {
    return undefined;
  }
  const name = ghStr({ value: raw["name"] });
  const url = ghStr({ value: raw["html_url"] });
  return {
    attrs: {
      ...optAttr({
        key: "publicRepos",
        value: typeof raw["public_repos"] === "number" ? raw["public_repos"] : undefined,
      }),
    },
    fetchedAtIso,
    identity: { nativeId: login, ...(name !== undefined ? { name } : {}), ...(url !== undefined ? { url } : {}) },
    kind: "org",
    provenance: ["github.orgs.get"],
    raw,
    relations: [],
    source: "github",
    sourceId: login,
    version: 1,
    warnings: [],
  };
}

/** Project one repo object (`repos.listForOrg`) into a `repo` structure row. Pure — undefined without full_name. */
export function projectRepoRow({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const fullName = isRecord(raw) ? ghStr({ value: raw["full_name"] }) : undefined;
  if (!isRecord(raw) || fullName === undefined) {
    return undefined;
  }
  const name = ghStr({ value: raw["name"] });
  const url = ghStr({ value: raw["html_url"] });
  const language = ghStr({ value: raw["language"] });
  const defaultBranch = ghStr({ value: raw["default_branch"] });
  const visibility = ghStr({ value: raw["visibility"] });
  return {
    attrs: {
      archived: raw["archived"] === true,
      fork: raw["fork"] === true,
      private: raw["private"] === true,
      ...(language !== undefined ? { language } : {}),
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
    },
    fetchedAtIso,
    identity: {
      nativeId: fullName,
      slug: fullName,
      ...(name !== undefined ? { name } : {}),
      ...(url !== undefined ? { url } : {}),
    },
    kind: "repo",
    provenance: ["github.orgs.listRepos"],
    raw,
    relations: [],
    source: "github",
    sourceId: fullName,
    version: 1,
    warnings: [],
  };
}

/** The `member` relations off a team's member logins (each points at a `github:<login>` person). Pure. */
function teamMemberRelations({ members }: { members: readonly unknown[] }): readonly StructureRelation[] {
  return members
    .map((member) => (isRecord(member) ? ghStr({ value: member["login"] }) : undefined))
    .filter((login): login is string => login !== undefined)
    .map((login) => ({ targetId: `github:${login}`, targetKind: "person", targetSource: "person", type: "member" }));
}

/** The `permission` relations off a team's repos (each carries the access level). Pure. */
function teamRepoRelations({ repos }: { repos: readonly unknown[] }): readonly StructureRelation[] {
  const relations: StructureRelation[] = [];
  for (const repo of repos) {
    const fullName = isRecord(repo) ? ghStr({ value: repo["full_name"] }) : undefined;
    if (fullName === undefined) {
      continue;
    }
    const permission = isRecord(repo) ? ghStr({ value: repo["permission"] }) : undefined;
    relations.push({
      targetId: fullName,
      targetKind: "repo",
      targetSource: "github",
      type: "permission",
      ...(permission !== undefined ? { attrs: { permission } } : {}),
    });
  }
  return relations;
}

/** Project one team (+ its members + repo permissions) into a `team` structure row. Pure — undefined without a slug. */
export function projectTeamRow({
  raw,
  members,
  repos,
  fetchedAtIso,
}: {
  raw: unknown;
  members: readonly unknown[];
  repos: readonly unknown[];
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const slug = isRecord(raw) ? ghStr({ value: raw["slug"] }) : undefined;
  if (!isRecord(raw) || slug === undefined) {
    return undefined;
  }
  const name = ghStr({ value: raw["name"] });
  const url = ghStr({ value: raw["html_url"] });
  const description = ghStr({ value: raw["description"] });
  const privacy = ghStr({ value: raw["privacy"] });
  return {
    attrs: {
      ...(description !== undefined ? { description } : {}),
      ...(privacy !== undefined ? { privacy } : {}),
    },
    fetchedAtIso,
    identity: {
      nativeId: slug,
      slug,
      ...(name !== undefined ? { name } : {}),
      ...(url !== undefined ? { url } : {}),
    },
    kind: "team",
    provenance: ["github.teams.list"],
    raw,
    relations: [...teamMemberRelations({ members }), ...teamRepoRelations({ repos })],
    source: "github",
    sourceId: slug,
    version: 1,
    warnings: [],
  };
}

/** Page an org's repos to exhaustion (bounded by the hard page cap). */
async function listAllRepos({ api, org }: { api: GithubOrgApi; org: string }): Promise<readonly unknown[]> {
  const repos: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api.listRepos({ org, page });
    repos.push(...batch);
    if (batch.length < PER_PAGE) {
      break;
    }
  }
  return repos;
}

/** The short repo name off a raw repo object (`name`), else undefined. Pure. */
function repoShortName({ raw }: { raw: unknown }): string | undefined {
  return isRecord(raw) ? ghStr({ value: raw["name"] }) : undefined;
}

/**
 * Enumerate + select the org's repo COORDINATES for the activity fan-out (the lean path — no org/teams
 * structural fetch). A `listRepos` failure is fatal (`err`); include/exclude/cap warnings flow through.
 *
 * @param api the injected org seam
 * @param org the org login
 * @param include include globs (empty ⇒ all repos)
 * @param exclude exclude globs
 * @param cap the max repos to ingest (undefined ⇒ no cap)
 * @returns the selected `{owner, repo}` coordinates + warnings, or `err` on a fatal repo failure
 */
export async function enumerateOrgRepos({
  api,
  org,
  include,
  exclude,
  cap,
}: {
  api: GithubOrgApi;
  org: string;
  include: readonly string[];
  exclude: readonly string[];
  cap: number | undefined;
}): Promise<Result<{ repos: readonly Repository[]; warnings: readonly string[] }>> {
  let repoRaws: readonly unknown[];
  try {
    repoRaws = await listAllRepos({ api, org });
  } catch (error: unknown) {
    return err([`github repo enumeration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const names = repoRaws.map((raw) => repoShortName({ raw })).filter((n): n is string => n !== undefined);
  const selection = selectRepoNames({ cap, exclude, include, names });
  const wanted = new Set(selection.selected);
  const repos = [...wanted].toSorted().map((repo) => ({ owner: org, repo }));
  return ok({ repos, warnings: selection.warnings });
}

/** The selected repos' rows + their `{owner, repo}` coordinates (for the activity fan-out). Pure. */
export function buildRepoRows({
  repos,
  selection,
  org,
  fetchedAtIso,
}: {
  repos: readonly unknown[];
  selection: RepoSelection;
  org: string;
  fetchedAtIso: string;
}): { rows: readonly StructureBronzeRow[]; coords: readonly Repository[] } {
  const wanted = new Set(selection.selected);
  const rows: StructureBronzeRow[] = [];
  const coords: Repository[] = [];
  for (const raw of repos) {
    const name = repoShortName({ raw });
    if (name === undefined || !wanted.has(name)) {
      continue;
    }
    const row = projectRepoRow({ fetchedAtIso, raw });
    if (row !== undefined) {
      rows.push(row);
      coords.push({ owner: org, repo: name });
    }
  }
  return { coords, rows };
}

/** Fetch + project the org's teams (members + repo permissions). A scope gap ⇒ warning, empty rows. */
async function buildTeamRows({
  api,
  org,
  fetchedAtIso,
}: {
  api: GithubOrgApi;
  org: string;
  fetchedAtIso: string;
}): Promise<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }> {
  const teams = await api.listTeams({ org });
  if (teams.ok === false) {
    return { rows: [], warnings: teams.errors };
  }
  const rows: StructureBronzeRow[] = [];
  const warnings: string[] = [];
  for (const raw of teams.value) {
    const slug = isRecord(raw) ? ghStr({ value: raw["slug"] }) : undefined;
    if (slug === undefined) {
      continue;
    }
    const built = await buildOneTeamRow({ api, fetchedAtIso, org, raw, slug });
    warnings.push(...built.warnings);
    if (built.row !== undefined) {
      rows.push(built.row);
    }
  }
  return { rows, warnings };
}

/**
 * Fetch ONE team's members + repo permissions and project its row. A members/repos failure DEGRADES to a
 * warning + the missing side left empty (the team row still lands) — so one team's scope gap never crashes
 * the whole structural pass. Mirrors the `read:org` degrade policy at the per-team granularity.
 */
async function buildOneTeamRow({
  api,
  org,
  slug,
  raw,
  fetchedAtIso,
}: {
  api: GithubOrgApi;
  org: string;
  slug: string;
  raw: unknown;
  fetchedAtIso: string;
}): Promise<{ row?: StructureBronzeRow; warnings: readonly string[] }> {
  const warnings: string[] = [];
  let members: readonly unknown[] = [];
  let repos: readonly unknown[] = [];
  try {
    members = await api.listTeamMembers({ org, teamSlug: slug });
  } catch (error: unknown) {
    warnings.push(`github team ${slug} members unavailable: ${error instanceof Error ? error.message : "unknown"}`);
  }
  try {
    repos = await api.listTeamRepos({ org, teamSlug: slug });
  } catch (error: unknown) {
    warnings.push(`github team ${slug} repos unavailable: ${error instanceof Error ? error.message : "unknown"}`);
  }
  const row = projectTeamRow({ fetchedAtIso, members, raw, repos });
  return { warnings, ...(row !== undefined ? { row } : {}) };
}

/** The result of a GitHub structural hydration: the rows, warnings, and the repos to fan activity over. */
export interface GithubStructures {
  readonly rows: readonly StructureBronzeRow[];
  readonly warnings: readonly string[];
  readonly repos: readonly Repository[];
}

/**
 * Hydrate an org's structure: the org row, its selected repos, and its teams (+ members + repo permissions).
 * A missing org / teams scope DEGRADES to a warning (partial structure), never a crash. A `listRepos` failure
 * is fatal (`err`) — with no repo set there's nothing to ingest.
 *
 * @param api the injected org seam
 * @param org the org login
 * @param include include globs (empty ⇒ all repos)
 * @param exclude exclude globs
 * @param cap the max repos to ingest (undefined ⇒ no cap)
 * @param fetchedAtIso the hydration timestamp
 * @returns the structure rows + warnings + the selected repo coordinates, or `err` on a fatal repo failure
 */
export async function fetchGithubStructures({
  api,
  org,
  include,
  exclude,
  cap,
  fetchedAtIso,
}: {
  api: GithubOrgApi;
  org: string;
  include: readonly string[];
  exclude: readonly string[];
  cap: number | undefined;
  fetchedAtIso: string;
}): Promise<Result<GithubStructures>> {
  let repoRaws: readonly unknown[];
  try {
    repoRaws = await listAllRepos({ api, org });
  } catch (error: unknown) {
    return err([`github repo enumeration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const orgRaw = await api.getOrg({ org });
  const orgRow = projectOrgRow({ fetchedAtIso, raw: orgRaw });
  const names = repoRaws.map((raw) => repoShortName({ raw })).filter((n): n is string => n !== undefined);
  const selection = selectRepoNames({ cap, exclude, include, names });
  const { rows: repoRows, coords } = buildRepoRows({ fetchedAtIso, org, repos: repoRaws, selection });
  const teams = await buildTeamRows({ api, fetchedAtIso, org });
  const warnings = [
    ...(orgRow === undefined ? ["github: org info unavailable (orgs.get) — org row skipped"] : []),
    ...selection.warnings,
    ...teams.warnings,
  ];
  return ok({
    repos: coords,
    rows: [...(orgRow !== undefined ? [orgRow] : []), ...repoRows, ...teams.rows],
    warnings,
  });
}

/** Page a team-scoped org list (members / repos) to exhaustion, via a page fetcher. */
async function pageAll({
  fetch,
}: {
  fetch: (page: number) => Promise<readonly unknown[]>;
}): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetch(page);
    items.push(...batch);
    if (batch.length < PER_PAGE) {
      break;
    }
  }
  return items;
}

/**
 * Build the production GitHub org seam over a resilient octokit client. Every SDK call is routed through a
 * `safe*` wrapper; `getOrg` degrades to undefined and `listTeams` degrades to `err` (a `read:org` scope gap
 * becomes a warning upstream, never a throw).
 *
 * @param token the GitHub token (org-admin + `read:org` needed for teams + private repos)
 * @returns the live org seam
 */
export function makeGithubOrgApi({ token }: { token: string | undefined }): GithubOrgApi {
  const client = makeGithubClient({ token });
  return {
    getOrg: ({ org }) => getOrgSafe({ client, org }),
    listRepos: async ({ org, page }) =>
      orThrow({
        result: await safeApiCall({
          execute: () => client.rest.repos.listForOrg({ org, page, per_page: PER_PAGE, type: "all" }),
          operation: "github.orgs.listRepos",
          provider: "github",
        }),
      }).data,
    listTeamMembers: ({ org, teamSlug }) =>
      pageAll({
        fetch: async (page) =>
          orThrow({
            result: await safeApiCall({
              execute: () => client.rest.teams.listMembersInOrg({ org, page, per_page: PER_PAGE, team_slug: teamSlug }),
              operation: "github.teams.listMembersInOrg",
              provider: "github",
            }),
          }).data,
      }),
    listTeamRepos: ({ org, teamSlug }) =>
      pageAll({
        fetch: async (page) =>
          orThrow({
            result: await safeApiCall({
              execute: () => client.rest.teams.listReposInOrg({ org, page, per_page: PER_PAGE, team_slug: teamSlug }),
              operation: "github.teams.listReposInOrg",
              provider: "github",
            }),
          }).data,
      }),
    listTeams: ({ org }) => listTeamsSafe({ client, org }),
  };
}

/** `orgs.get` — non-fatal (a 404/blocked org yields `undefined`, not a throw). */
async function getOrgSafe({ client, org }: { client: GithubClient; org: string }): Promise<unknown | undefined> {
  const res = await safeApiCall({
    execute: () => client.rest.orgs.get({ org }),
    operation: "github.orgs.get",
    provider: "github",
  });
  return res.isOk() ? res.value.data : undefined;
}

/** `teams.list` (paged) — `err` on a `read:org` scope gap so the caller degrades to a warning. */
async function listTeamsSafe({
  client,
  org,
}: {
  client: GithubClient;
  org: string;
}): Promise<Result<readonly unknown[]>> {
  const res = await safeApiCall({
    execute: () =>
      pageAll({
        fetch: (page) => client.rest.teams.list({ org, page, per_page: PER_PAGE }).then((r) => r.data),
      }),
    operation: "github.teams.list",
    provider: "github",
  });
  return res.isOk()
    ? ok(res.value)
    : err([`github: teams unavailable (${res.error.message}) — needs an org-admin token with read:org`]);
}
