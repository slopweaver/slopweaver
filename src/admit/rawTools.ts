/**
 * The raw-bypass classifier — the pure core behind the PreToolUse hook. It decides whether a shell
 * command is a RAW side-effecting tool that would reach past the door (so the agent could merge a PR or
 * force-push without any gate), and blocks those BY DEFAULT with an informative escape. It is deliberately
 * narrow, not heavy-handed (D10): read-only `git`/`gh` (the hygiene gate itself runs `git ls-files`) and
 * everything unrecognised are ALLOWED — only external/destructive raw ops are blocked, and always with a
 * real path forward (`SLOPWEAVER_ALLOW_RAW=1`, single-run break-glass).
 *
 * It resolves the tool + subcommand robustly: it strips an `env`/`VAR=VAL` prefix and skips `git` global
 * flags (`git -C <dir> push`, `git --git-dir=… push`) so the destructive subcommand isn't hidden behind
 * them. Pure: `command` + `allowRaw` in, a verdict out.
 */

/**
 * The verdict for one command — a discriminated union so a `blocked` verdict ALWAYS carries its `tool`,
 * `reason`, and `message` (no optional fields to `?? ''` around). An allowed verdict may name the tool
 * (e.g. when the escape waived it).
 */
export type RawVerdict =
  | { readonly blocked: true; readonly tool: string; readonly reason: string; readonly message: string }
  | { readonly blocked: false; readonly tool?: string };

/** The escape hatch, quoted verbatim in every block message so the path forward is never hidden. */
export const RAW_ESCAPE = "SLOPWEAVER_ALLOW_RAW=1";

/** `gh <group> <sub>` combinations that MUTATE (create/merge/close/delete/edit/…). Read verbs are absent ⇒ allowed. */
const GH_MUTATIONS: Readonly<Record<string, readonly string[]>> = {
  cache: ["delete"],
  gist: ["create", "edit", "delete"],
  issue: ["create", "close", "reopen", "edit", "comment", "delete", "lock", "unlock", "transfer", "pin", "unpin"],
  label: ["create", "edit", "delete"],
  pr: ["create", "merge", "close", "reopen", "ready", "edit", "comment", "review", "lock", "unlock"],
  release: ["create", "edit", "delete", "upload"],
  repo: ["create", "delete", "edit", "archive", "rename", "sync"],
  run: ["cancel", "rerun", "delete"],
  secret: ["set", "delete"],
  variable: ["set", "delete"],
  workflow: ["run", "enable", "disable"],
};

/** Write HTTP methods for `gh api` / `curl` — the tell that a request MUTATES rather than reads. */
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

/** `git` global flags (before the subcommand) that CONSUME the next token as their value. */
const GIT_VALUE_GLOBALS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
]);

/** Strip a leading `env …`/`VAR=VAL …` prefix so `env X=1 git push` / `FOO=bar gh pr merge` still resolve. */
function stripEnvPrefix({ tokens }: { tokens: readonly string[] }): readonly string[] {
  let i = 0;
  if (tokens[i] === "env") {
    i += 1;
    while (i < tokens.length) {
      const token = tokens[i]!; // i < tokens.length ⇒ in-bounds
      if (token === "-i" || token === "--ignore-environment") {
        i += 1;
      } else if (token === "-u" || token === "--unset") {
        i += 2; // consumes the NAME to unset
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        i += 1;
      } else {
        break;
      }
    }
    return tokens.slice(i);
  }
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
    i += 1;
  }
  return tokens.slice(i);
}

/** The basename of the tool token (`/usr/bin/gh` ⇒ `gh`). A split always yields ≥1 element, so `pop()` is safe. */
function toolName({ first }: { first: string }): string {
  return first.split("/").pop()!;
}

/** Resolve `git`'s subcommand + its flags, skipping global flags (and their values). */
function gitSubcommand({ tokens }: { tokens: readonly string[] }): {
  sub: string | undefined;
  flags: readonly string[];
} {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!; // i < tokens.length ⇒ in-bounds
    if (token.startsWith("-")) {
      i += GIT_VALUE_GLOBALS.has(token) ? 2 : 1; // a value-global (spaced form) also eats the next token
      continue;
    }
    return { flags: tokens.slice(i + 1), sub: token };
  }
  return { flags: [], sub: undefined };
}

/** The first two non-flag tokens after `gh` — its group + subcommand. */
function ghGroupSub({ tokens }: { tokens: readonly string[] }): {
  group: string | undefined;
  sub: string | undefined;
  rest: readonly string[];
} {
  const words = tokens.slice(1).filter((t) => !t.startsWith("-"));
  return { group: words[0], rest: tokens.slice(1), sub: words[1] };
}

/** Destructive / external `git` subcommand shapes (status/log/diff/add/commit/fetch are allowed). */
function isDestructiveGit({ tokens }: { tokens: readonly string[] }): boolean {
  const { sub, flags } = gitSubcommand({ tokens });
  if (sub === undefined) {
    return false;
  }
  if (sub === "push") {
    return true; // any push reaches the remote — route it through the door
  }
  if (sub === "reset") {
    return flags.includes("--hard");
  }
  if (sub === "clean") {
    return flags.some((f) => /^-[a-z]*f/.test(f)); // -f / -fd / -ffd …
  }
  if (sub === "branch" || sub === "tag") {
    return flags.some((f) => f === "-d" || f === "-D" || f === "--delete");
  }
  return ["rebase", "filter-branch"].includes(sub);
}

/** Whether a `gh` invocation mutates: a known mutating group/sub, or `gh api` with a write method / fields. */
function isMutatingGh({ tokens }: { tokens: readonly string[] }): boolean {
  const { group, sub, rest } = ghGroupSub({ tokens });
  if (group === undefined) {
    return false;
  }
  if (group === "api") {
    const hasFields = rest.some(
      (t) => t === "-f" || t === "-F" || t === "--field" || t === "--raw-field" || t === "--input",
    );
    // Method comes as `-X POST`, `--method POST`, `--method=POST`, or the attached `-XPOST`.
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i]!; // i < rest.length ⇒ in-bounds
      const attached = /^(?:-X|--method=)(.+)$/.exec(token);
      const method = attached?.[1] ?? (token === "-X" || token === "--method" ? rest[i + 1] : undefined);
      if (method !== undefined && WRITE_METHODS.has(method.toLowerCase())) {
        return true;
      }
    }
    return hasFields;
  }
  return sub !== undefined && (GH_MUTATIONS[group]?.includes(sub) ?? false);
}

/**
 * Classify a shell command as a blocked raw-bypass tool or allowed. `curl`/`wget` (external), mutating
 * `gh`, and destructive/pushing `git` are blocked unless `allowRaw`; read-only + unrecognised commands pass.
 *
 * @param command the raw shell command line
 * @param allowRaw whether `SLOPWEAVER_ALLOW_RAW=1` is set (the break-glass)
 * @returns the verdict
 */
export function classifyRawCommand({ command, allowRaw }: { command: string; allowRaw: boolean }): RawVerdict {
  const tokens = stripEnvPrefix({
    tokens: command
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  });
  const first = tokens[0];
  if (first === undefined) {
    return { blocked: false }; // empty command — nothing to classify
  }
  const tool = toolName({ first });
  let reason: string | undefined;
  if (tool === "curl" || tool === "wget") {
    reason = `raw ${tool} bypasses the door for external requests`;
  } else if (tool === "gh" && isMutatingGh({ tokens })) {
    reason = "raw gh mutates GitHub outside the door";
  } else if (tool === "git" && isDestructiveGit({ tokens })) {
    reason = "raw git performs a pushing/destructive operation outside the door";
  }
  if (reason === undefined) {
    return { blocked: false };
  }
  if (allowRaw) {
    return { blocked: false, tool };
  }
  return {
    blocked: true,
    message: `Slopweaver blocks raw side effects by default: ${reason}. Route it through the door (run the matching \`slopweaver\` verb), or set ${RAW_ESCAPE} for this one run.`,
    reason,
    tool,
  };
}
