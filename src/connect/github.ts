/**
 * GitHub preflight: prove the token reaches the org (a 1-item repo list), verify `read:org` (an org-admin
 * scope member+structure hydration needs — a team read that a scope gap blocks), and report the SAML
 * external-identity capability (the login→SSO-email join). SAML is genuinely org-admin + SAML-org
 * dependent, so its absence is REPORTED as a non-fatal warning (public-profile email still works), never
 * inferred away. Pure classifier + thin injected-probe shell.
 */
import type { IngestError } from "../lib/ingestError.js";
import type { TypedResult } from "../lib/result.js";
import { type ConnectCapability, type ConnectCheckReport, finaliseReport } from "./types.js";

/** The raw outcome of the GitHub probes. */
export interface GithubProbe {
  /** Whether an actual token was supplied (GitHub can probe a public org unauthenticated). */
  readonly tokenPresent: boolean;
  readonly authReachable: boolean;
  readonly teamsReadable: boolean;
  readonly samlPresent: boolean;
  readonly reposSampled: number;
}

/** The injectable GitHub probe bag — a 1-item repo list (auth + read probe), team read, SAML probe. */
export interface GithubConnectProbes {
  repos(): Promise<TypedResult<{ sampled: number }, IngestError>>;
  org(): Promise<TypedResult<{ teamsReadable: boolean }, IngestError>>;
  saml(): Promise<TypedResult<{ present: boolean }, IngestError>>;
}

/** The `read:org` scope verdict (team read succeeds ⇒ ok; blocked ⇒ a hard gap). */
function readOrgCapability({ probe }: { probe: GithubProbe }): ConnectCapability {
  if (probe.teamsReadable) {
    return { detail: "team read succeeded — read:org is present", id: "scope:read:org", status: "ok" };
  }
  return {
    detail: "teams unreadable — needs an org-admin token with read:org for structure/member hydration",
    id: "scope:read:org",
    status: "missing",
  };
}

/** The SAML external-identity capability (SSO-email join): present ⇒ ok, absent ⇒ a non-fatal warning. */
function samlCapability({ probe }: { probe: GithubProbe }): ConnectCapability {
  if (probe.samlPresent) {
    return {
      detail: "SAML external identities visible — login→SSO-email join available",
      id: "capability:saml-email",
      status: "ok",
    };
  }
  return {
    detail: "no SAML external identities (needs a SAML org + org-admin) — emails limited to public profile",
    id: "capability:saml-email",
    status: "warning",
  };
}

/** The 1-item read-probe verdict (any repo visible ⇒ ok; nothing ⇒ no-data-visible). */
function readCapability({ probe }: { probe: GithubProbe }): ConnectCapability {
  if (probe.reposSampled > 0) {
    return { detail: `read probe saw ${String(probe.reposSampled)} repo(s)`, id: "read-probe", status: "ok" };
  }
  return {
    detail: "auth ok but no repos visible — the org is empty or the token cannot see it",
    id: "read-probe",
    status: "missing",
  };
}

/**
 * Classify a GitHub probe into a report. Pure.
 *
 * @param probe the raw probe outcome
 * @returns the finalised report
 */
export function classifyGithub({ probe }: { probe: GithubProbe }): ConnectCheckReport {
  if (!probe.authReachable) {
    return finaliseReport({
      capabilities: [
        {
          detail: "could not reach the org — the token is invalid, missing, or the org name is wrong",
          id: "auth",
          status: "missing",
        },
      ],
      errors: ["github: could not reach the org"],
      source: "github",
      tokenPresent: probe.tokenPresent,
    });
  }
  return finaliseReport({
    capabilities: [
      {
        detail: probe.tokenPresent ? "reached the org (authenticated)" : "reached the org (unauthenticated)",
        id: "auth",
        status: "ok",
      },
      readOrgCapability({ probe }),
      samlCapability({ probe }),
      readCapability({ probe }),
    ],
    source: "github",
    tokenPresent: probe.tokenPresent,
  });
}

/**
 * Run the GitHub probes and classify. Effectful shell over the injected bag.
 *
 * @param probes the injected probe bag
 * @returns the preflight report
 */
export async function checkGithubConnection({
  probes,
  tokenPresent,
}: {
  probes: GithubConnectProbes;
  tokenPresent: boolean;
}): Promise<ConnectCheckReport> {
  const [repos, org, saml] = await Promise.all([probes.repos(), probes.org(), probes.saml()]);
  return classifyGithub({
    probe: {
      authReachable: repos.isOk(),
      reposSampled: repos.isOk() ? repos.value.sampled : 0,
      samlPresent: saml.isOk() ? saml.value.present : false,
      teamsReadable: org.isOk() ? org.value.teamsReadable : false,
      tokenPresent,
    },
  });
}
