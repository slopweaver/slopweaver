/**
 * `slopweaver connect <github|slack|linear|notion> --check [--json]` — the read-only preflight. It proves a
 * source's token reaches the API and reports the EXACT scopes/capabilities that source's ingest needs
 * (Slack `users:read.email`, Notion read-user-email, GitHub `read:org` + SAML), plus a 1-item read probe
 * that catches "token valid but no data visible". `--json` emits a stable, value-free shape the
 * `/slopweaver:onboard` slash command branches on. Diagnostic + external-read: a non-zero exit REPORTS a
 * not-ready connection (a finding), never a broken tool; nothing is written, nothing outbound is mutated.
 *
 * A thin effectful shell: arg parsing ({@link parseConnectArgs}) + org resolution + the per-source report
 * classification are pure/injected; the SDK probes are the only I/O, wired in {@link productionConnectDeps}
 * and faked in tests, so dispatch + JSON + the exit code are unit-tested with plain fakes.
 */
import {
  githubToken,
  linearToken,
  notionToken,
  parseRepositorySlug,
  resolveRepository,
  slackBotToken,
  slackUserToken,
} from "../../../config.js";
import { checkGithubConnection } from "../../../connect/github.js";
import { checkLinearConnection } from "../../../connect/linear.js";
import { checkNotionConnection } from "../../../connect/notion.js";
import {
  makeGithubConnectProbes,
  makeLinearConnectProbes,
  makeNotionConnectProbes,
  makeSlackConnectProbes,
} from "../../../connect/probes.js";
import { renderConnectJson, renderConnectText } from "../../../connect/render.js";
import { checkSlackConnection } from "../../../connect/slack.js";
import { type ConnectCheckReport, type ConnectSource, noTokenReport } from "../../../connect/types.js";
import { resolveSlackReadToken } from "../../../corpus/slack/fetch.js";
import type { Logger } from "../../../lib/logger.js";
import { logger } from "../../../lib/logger.js";
import { err, ok, type Result } from "../../../lib/result.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlagTail } from "../../optionParsers.js";

const USAGE =
  "usage: slopweaver connect <github|slack|linear|notion> --check [--json] [--repo owner/repo] [--github-org <org>]";

const CONNECT_SOURCES: readonly ConnectSource[] = ["github", "slack", "linear", "notion"];

/** The validated `connect` request. */
interface ConnectArgs {
  readonly source: ConnectSource;
  readonly json: boolean;
  readonly repo?: string;
  readonly githubOrg?: string;
}

/**
 * Parse the `connect` tail: a leading `<source>` positional then flags. Pure — a missing/unknown source or
 * a bad flag is an error. `--check` is accepted (the only mode) but not required.
 *
 * @param rest the tail after `connect` (a leading `check` verb word already stripped)
 * @returns the validated request, or the accumulated errors
 */
export function parseConnectArgs({ rest }: { rest: readonly string[] }): Result<ConnectArgs> {
  const rawSource = rest[0];
  if (rawSource === undefined || rawSource.startsWith("-")) {
    return err([`missing source (expected ${CONNECT_SOURCES.join(" | ")})`, USAGE]);
  }
  if (!CONNECT_SOURCES.includes(rawSource as ConnectSource)) {
    return err([`unknown source: ${rawSource} (expected ${CONNECT_SOURCES.join(" | ")})`, USAGE]);
  }
  const parsed = parseFlagTail({
    rest: rest.slice(1),
    spec: { boolean: ["check", "json"], value: ["repo", "github-org"] },
  });
  if (parsed.ok === false) {
    return err([...parsed.errors, USAGE]);
  }
  const { values } = parsed.value;
  return ok({
    json: parsed.value.flags.has("json"),
    source: rawSource as ConnectSource,
    ...(values["repo"] !== undefined ? { repo: values["repo"] } : {}),
    ...(values["github-org"] !== undefined ? { githubOrg: values["github-org"] } : {}),
  });
}

/** The resolved Slack read token + its kind (user beats bot; none ⇒ unconfigured). */
interface SlackRead {
  readonly token?: string;
  readonly kind: "user" | "bot" | "none";
}

/** The injectable effectful seams the `connect` shell composes (fakes in tests, production below). */
export interface ConnectDeps {
  readonly githubToken: () => string | undefined;
  readonly slackRead: () => SlackRead;
  readonly linearToken: () => string | undefined;
  readonly notionToken: () => string | undefined;
  readonly resolveGithubOrg: (args: { repo?: string; githubOrg?: string }) => Result<string>;
  readonly connectGithub: (args: { org: string; token: string | undefined }) => Promise<ConnectCheckReport>;
  readonly connectSlack: (args: { token: string; kind: "user" | "bot" }) => Promise<ConnectCheckReport>;
  readonly connectLinear: (args: { token: string }) => Promise<ConnectCheckReport>;
  readonly connectNotion: (args: { token: string }) => Promise<ConnectCheckReport>;
  readonly logger: Pick<Logger, "out" | "error">;
}

/** The GitHub branch: resolve the org, then probe (a public probe when no token — read:org will surface). */
async function githubReport({ args, deps }: { args: ConnectArgs; deps: ConnectDeps }): Promise<ConnectCheckReport> {
  const org = deps.resolveGithubOrg({
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    ...(args.githubOrg !== undefined ? { githubOrg: args.githubOrg } : {}),
  });
  if (org.ok === false) {
    return noTokenReport({ hint: `could not resolve the org: ${org.errors.join("; ")}`, source: "github" });
  }
  return deps.connectGithub({ org: org.value, token: deps.githubToken() });
}

/** Dispatch to the requested source's report, short-circuiting to a no-token report when unconfigured. */
async function reportFor({ args, deps }: { args: ConnectArgs; deps: ConnectDeps }): Promise<ConnectCheckReport> {
  if (args.source === "github") {
    return githubReport({ args, deps });
  }
  if (args.source === "slack") {
    const read = deps.slackRead();
    return read.token !== undefined && read.kind !== "none"
      ? deps.connectSlack({ kind: read.kind, token: read.token })
      : noTokenReport({
          hint: "set SLACK_USER_TOKEN or: slopweaver secrets set slack-user-token --stdin",
          source: "slack",
        });
  }
  if (args.source === "linear") {
    const token = deps.linearToken();
    return token !== undefined
      ? deps.connectLinear({ token })
      : noTokenReport({ hint: "set LINEAR_API_KEY or: slopweaver secrets set linear-token --stdin", source: "linear" });
  }
  const token = deps.notionToken();
  return token !== undefined
    ? deps.connectNotion({ token })
    : noTokenReport({ hint: "set NOTION_TOKEN or: slopweaver secrets set notion-token --stdin", source: "notion" });
}

/**
 * Run `connect` over injected dependencies — the testable shell.
 *
 * @param argv the full process argv
 * @param deps the effectful seams
 * @returns the process exit code (0 ready, 2 usage, 3 not-ready finding)
 */
export async function runConnectWithDeps({
  argv,
  deps,
}: {
  argv: readonly string[];
  deps: ConnectDeps;
}): Promise<number> {
  const tail = argv.slice(3);
  const rest = tail[0] === "check" ? tail.slice(1) : tail;
  if (rest.includes("--help") || rest.includes("-h") || rest.length === 0) {
    deps.logger.out(USAGE);
    return rest.length === 0 ? EXIT_USAGE : EXIT_OK;
  }
  const parsed = parseConnectArgs({ rest });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      deps.logger.error(e);
    });
    return EXIT_USAGE;
  }
  const report = await reportFor({ args: parsed.value, deps });
  if (parsed.value.json) {
    deps.logger.out(renderConnectJson({ report }));
  } else {
    renderConnectText({ report }).forEach((line) => {
      deps.logger.out(line);
    });
  }
  return report.ok ? EXIT_OK : EXIT_EXPECTED_EMPTY;
}

/** Resolve the Slack read token + kind: a user token wins, else a bot token, else none. */
function productionSlackRead(): SlackRead {
  const userToken = slackUserToken();
  const botToken = slackBotToken();
  const resolved = resolveSlackReadToken({ botToken, userToken });
  if (resolved.token === undefined) {
    return { kind: "none" };
  }
  return { kind: userToken !== undefined ? "user" : "bot", token: resolved.token };
}

/** Resolve the GitHub org: `--github-org`, else `--repo` owner, else the current `origin` remote's owner. */
function productionResolveGithubOrg({ repo, githubOrg }: { repo?: string; githubOrg?: string }): Result<string> {
  if (githubOrg !== undefined) {
    return ok(githubOrg);
  }
  const parsed = repo !== undefined ? parseRepositorySlug({ slug: repo }) : resolveRepository();
  return parsed.ok ? ok(parsed.value.owner) : parsed;
}

/** Production dependencies (real token reads + SDK probes). */
function productionConnectDeps(): ConnectDeps {
  return {
    connectGithub: ({ org, token }) =>
      checkGithubConnection({ probes: makeGithubConnectProbes({ org, token }), tokenPresent: token !== undefined }),
    connectLinear: ({ token }) => checkLinearConnection({ probes: makeLinearConnectProbes({ token }) }),
    connectNotion: ({ token }) => checkNotionConnection({ probes: makeNotionConnectProbes({ token }) }),
    connectSlack: ({ kind, token }) =>
      checkSlackConnection({ probes: makeSlackConnectProbes({ token }), tokenKind: kind }),
    githubToken,
    linearToken,
    logger: {
      error: (m) => {
        logger.error(m);
      },
      out: (m) => {
        logger.out(m);
      },
    },
    notionToken,
    resolveGithubOrg: productionResolveGithubOrg,
    slackRead: productionSlackRead,
  };
}

/**
 * Run the `connect` verb.
 *
 * @param argv the full process argv
 * @returns the process exit code
 */
export async function runConnect(argv: readonly string[]): Promise<number> {
  return runConnectWithDeps({ argv, deps: productionConnectDeps() });
}

export const connectCheckCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: true,
  doorRouted: false,
  dryParseSafe: false,
  effect: "external-read",
  example: "slopweaver connect slack --check --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  run: runConnect,
  summary: "Preflight a source: reachability + the exact scopes/capabilities its ingest needs (+ a 1-item read)",
  usage: USAGE,
});
