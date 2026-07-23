import { describe, expect, it } from "vitest";
import { err, ok, type Result, unwrap } from "../../lib/result.js";
import { fetchGithubMembers, type GithubMembersApi, parseSamlPage, projectGithubMember } from "./members.js";

const GH_AT = "2026-07-20T00:00:00.000Z";

describe("projectGithubMember", () => {
  it("prefers the SAML SSO email over the public profile email and keeps the raw profile", () => {
    const profile = {
      avatar_url: "https://cdn/av.png",
      email: "public@example.org",
      login: "ada",
      name: "Ada Lovelace",
    };
    const row = projectGithubMember({
      fetchedAtIso: GH_AT,
      profile,
      samlEmail: "ada@example.com",
      stub: { login: "ada" },
    })!;
    expect(row.identity).toEqual({
      email: "ada@example.com",
      emailNormalised: "ada@example.com",
      emailTrust: "trusted",
      handle: "ada",
      name: "Ada Lovelace",
      nativeId: "ada",
      source: "github",
    });
    expect(row.provenance).toEqual(["github.orgs.listMembers", "github.saml"]);
    // FULL raw = the composite of BOTH source calls (the org-membership stub AND the profile), nothing lost.
    expect(row.raw).toEqual({ listMember: { login: "ada" }, profile });
  });

  it("falls back to the public profile email when there is no SAML join", () => {
    const row = projectGithubMember({
      fetchedAtIso: GH_AT,
      profile: { email: "grace@example.com", login: "grace" },
      stub: { login: "grace" },
    })!;
    expect(row.identity.email).toBe("grace@example.com");
    expect(row.provenance).toEqual(["github.orgs.listMembers"]);
  });

  it("warns (no guessed email) when neither SAML nor a public email is available", () => {
    const row = projectGithubMember({ fetchedAtIso: GH_AT, profile: { login: "eng" }, stub: { login: "eng" } })!;
    expect(row.identity.emailTrust).toBe("missing");
    expect(row.warnings).toEqual(["no email — GitHub public profile empty and no SAML SSO email resolved"]);
  });

  it("flags a Bot account", () => {
    const row = projectGithubMember({
      fetchedAtIso: GH_AT,
      profile: { login: "ci", type: "Bot" },
      stub: { login: "ci" },
    })!;
    expect(row.profile.bot).toBe(true);
  });
});

describe("parseSamlPage", () => {
  it("extracts login→nameId pairs and reports the provider present", () => {
    const data = {
      organization: {
        samlIdentityProvider: {
          externalIdentities: {
            nodes: [
              { samlIdentity: { nameId: "ada@example.com" }, user: { login: "ada" } },
              { samlIdentity: {}, user: { login: "x" } },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    };
    const page = parseSamlPage({ data });
    expect(page.hasProvider).toBe(true);
    expect(page.pairs).toEqual([["ada", "ada@example.com"]]); // the nameId-less node dropped
    expect(page.nextCursor).toBeUndefined();
  });

  it("reports no provider for a non-SAML org", () => {
    expect(parseSamlPage({ data: { organization: { samlIdentityProvider: null } } })).toEqual({
      hasProvider: false,
      pairs: [],
    });
  });
});

/** A fake GitHub member seam: one page of two members, per-login profiles, a canned SAML result. */
function fakeApi({ saml }: { saml: Result<ReadonlyMap<string, string>> }): GithubMembersApi {
  const profiles: Record<string, unknown> = {
    ada: { email: null, login: "ada", name: "Ada Lovelace" },
    grace: { email: "grace@example.com", login: "grace", name: "Grace Hopper" },
  };
  return {
    getUser: async ({ username }) => profiles[username],
    listMembers: async ({ page }) => (page === 1 ? [{ login: "ada" }, { login: "grace" }] : []),
    samlEmails: async () => saml,
  };
}

describe("fetchGithubMembers", () => {
  it("joins SAML emails, enriches profiles, and hydrates one row per member", async () => {
    const saml: Result<ReadonlyMap<string, string>> = ok(new Map([["ada", "ada@example.com"]]));
    const result = unwrap(await fetchGithubMembers({ api: fakeApi({ saml }), fetchedAtIso: GH_AT, org: "acme" }));
    expect(result.rows.map((r) => r.sourceId)).toEqual(["ada", "grace"]);
    expect(result.rows.map((r) => r.identity.email)).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("degrades to public/login-only with a warning when the org is not SAML-backed", async () => {
    const saml: Result<ReadonlyMap<string, string>> = err([
      "github: no SAML external identities (needs an org-admin token + a SAML org) — emails limited to public profile",
    ]);
    const result = unwrap(await fetchGithubMembers({ api: fakeApi({ saml }), fetchedAtIso: GH_AT, org: "acme" }));
    expect(result.warnings).toContain(
      "github: no SAML external identities (needs an org-admin token + a SAML org) — emails limited to public profile",
    );
    expect(result.rows.find((r) => r.sourceId === "ada")!.identity.emailTrust).toBe("missing"); // no guessed email
  });
});
