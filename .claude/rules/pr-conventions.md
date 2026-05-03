# PR conventions

How to write PRs in this repo.

## Title

Conventional commits style. The title becomes the squashed commit message on `main`, so it should read as a good commit message.

```
<type>(<scope>): <imperative summary>
```

Types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`.
Scope is optional but useful. Common scopes: `cli-tools`, `mcp-server`, `web-ui`, `db`, `auth`, `integrations`.

Good:

- `feat(cli-tools): add worktree subcommand`
- `fix(auth): handle expired token in mcp-rate-limit guard`
- `docs: clarify start_session vs catch_me_up in V1-SCOPE.md`
- `ci: bump GitHub Actions Node version to 22`

Bad:

- `Updates` (no type, no detail)
- `feat: lots of changes to mcp-server, db, and web-ui` (multiple scopes; should be 3 PRs)
- `Fixed bug` (passive, vague)

## Description

Use the PR template (`.github/pull_request_template.md`). Sections:

- **What this PR does** — 1-2 sentences. User-visible effect.
- **Why** — motivation. Link the issue (`closes #N` or `refs #N`).
- **Test plan** — how you verified. Bullet list of manual + automated checks.
- **Breaking changes** — list them, or "None."
- **Notes for the reviewer** — optional. Tradeoffs, things to call out.

## Size

Target ≤500 lines of diff (excluding generated files like `pnpm-lock.yaml`, migrations, `.snap` files). If a PR exceeds that, ask whether it should split.

Exception: a single new package skeleton (5-10 small files) often goes over 500 because of `package.json` + `tsconfig.json` + `README.md` + lockfile changes. That's fine.

## Scope discipline

One concern per PR. If you find yourself fixing an unrelated bug while implementing a feature, stop, file an issue for the bug, and address it in a separate PR. The exception is small drive-by typo fixes in a file you're already editing.

## Linked issues

Always link the issue the PR addresses, in the description body:

- `closes #42` — auto-closes the issue on merge
- `refs #42` — references without auto-closing

For PRs that come from `/fix-issue`, the issue link is automatic.

## CI must be green

Before requesting review:

- `pnpm format:check` ✅
- `pnpm lint` ✅
- `pnpm compile` ✅
- `pnpm test` ✅

CI runs these on every PR. A PR with red CI is not ready for review.

## Self-review

Before opening for review, look at your own diff in the GitHub PR view (not just locally). You'll often spot something that didn't show up in `git diff` — leftover console.log, accidental file inclusion, unrelated whitespace changes. Fix those before requesting review.
