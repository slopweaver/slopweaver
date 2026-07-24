/**
 * Notion preflight: `users.list` doubles as the cheapest auth call, so its success is reachability and its
 * rows verify the read-user-email capability (a `person` user carries an email only when the integration
 * was granted "read user information including email"). A 1-item search probe catches "authed but no pages
 * shared with the integration". Pure classifier ({@link classifyNotion}) + thin injected-probe shell.
 */
import type { IngestError } from "../lib/ingestError.js";
import type { TypedResult } from "../lib/result.js";
import { type ConnectCapability, type ConnectCheckReport, finaliseReport } from "./types.js";

/** The raw outcome of the Notion probes. */
export interface NotionProbe {
  readonly authReachable: boolean;
  readonly usersSampled: number;
  readonly anyPerson: boolean;
  readonly emailVisible: boolean;
  readonly pagesSampled: number;
}

/** The injectable Notion probe bag — `users.list` (auth + email) and a 1-item search (read probe). */
export interface NotionConnectProbes {
  users(): Promise<TypedResult<{ sampled: number; anyPerson: boolean; anyEmail: boolean }, IngestError>>;
  pages(): Promise<TypedResult<{ sampled: number }, IngestError>>;
}

/** The read-user-email capability verdict from the sampled users. */
function emailCapability({ probe }: { probe: NotionProbe }): ConnectCapability {
  const id = "capability:read-user-email";
  if (probe.emailVisible) {
    return { detail: "a person user exposed an email — the read-user-email capability is present", id, status: "ok" };
  }
  if (probe.anyPerson) {
    return {
      detail: "person user had no email — grant the integration the read-user-email capability",
      id,
      status: "missing",
    };
  }
  return { detail: "no person users visible to verify read-user-email", id, status: "warning" };
}

/** The 1-item read-probe verdict (a shared page/data source visible ⇒ ok; nothing ⇒ no-data-visible). */
function readCapability({ probe }: { probe: NotionProbe }): ConnectCapability {
  if (probe.pagesSampled > 0) {
    return {
      detail: `read probe saw ${String(probe.pagesSampled)} shared page/data source`,
      id: "read-probe",
      status: "ok",
    };
  }
  return {
    detail: "auth ok but no pages/data sources visible — share pages with the integration",
    id: "read-probe",
    status: "missing",
  };
}

/**
 * Classify a Notion probe into a report. Pure.
 *
 * @param probe the raw probe outcome
 * @returns the finalised report
 */
export function classifyNotion({ probe }: { probe: NotionProbe }): ConnectCheckReport {
  if (!probe.authReachable) {
    return finaliseReport({
      capabilities: [
        { detail: "users.list failed — the integration token is invalid or revoked", id: "auth", status: "missing" },
      ],
      errors: ["notion: users.list did not reach the workspace"],
      source: "notion",
      tokenPresent: true,
    });
  }
  return finaliseReport({
    capabilities: [
      { detail: "users.list reached the workspace", id: "auth", status: "ok" },
      emailCapability({ probe }),
      readCapability({ probe }),
    ],
    source: "notion",
    tokenPresent: true,
  });
}

/**
 * Run the Notion probes and classify. Effectful shell over the injected bag.
 *
 * @param probes the injected probe bag
 * @returns the preflight report
 */
export async function checkNotionConnection({ probes }: { probes: NotionConnectProbes }): Promise<ConnectCheckReport> {
  const [users, pages] = await Promise.all([probes.users(), probes.pages()]);
  const usersOk = users.isOk() ? users.value : { anyEmail: false, anyPerson: false, sampled: 0 };
  return classifyNotion({
    probe: {
      anyPerson: usersOk.anyPerson,
      authReachable: users.isOk(),
      emailVisible: usersOk.anyEmail,
      pagesSampled: pages.isOk() ? pages.value.sampled : 0,
      usersSampled: usersOk.sampled,
    },
  });
}
