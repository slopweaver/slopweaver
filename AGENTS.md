# Working in this repo

Guidance for any agent (or human) contributing to Slopweaver. Read it before you touch code.

## What Slopweaver is

A Claude Code plugin that builds a **local-first, zero-key org world model** from a team's GitHub
history: ingest it → tier it (bronze → silver → gold) → ask questions of it — all on the user's
machine. Embeddings run on-device; the language model uses the user's existing Claude Code session.
No API keys, no data leaving the machine except the Claude calls the user already makes.

Start with `README.md` for the pitch, `docs/architecture.md` for the shape, and `docs/security.md`
for the trust model.

## Non-negotiable: no private identifiers, ever

This is a public repository. It must never contain any organisation's private identifiers — company
or team names, internal tool or project names, internal domains, private repo owners, or teammate
logins — **not even split, encoded, or fragmented** (that still ships the string and signals
concealment).

Two gates enforce this, by design kept apart:

- **Public hygiene gate** (`src/hygiene/scan.ts`, run via `scripts/check-hygiene.sh`) — ships in the
  repo and CI. It names no organisation. It detects generic leak _classes_: absolute home paths,
  token shapes, raw workspace-ID patterns.
- **Private denylist** — the actual org-specific words live only in `$SLOPWEAVER_HOME/hygiene-denylist.txt`,
  which is **never committed**. The gate reads it at runtime. This keeps the scanner from having to
  _contain_ the very words it guards against.

The committed lefthook `pre-push` hook runs the full gate (`yarn validate`, which includes hygiene) before
anything leaves the machine — see the Toolchain section. **Never weaken the gate to get a green.**

## Porting from private sources

Parts of this engine were designed against private, internal codebases. When you port a design:
re-implement it in this repo's own clean idiom, re-skin every name, and keep the gate green. Port
the _design_, never the code or naming verbatim.

## How we work

- **Verify, don't trust.** Never report a check green you haven't run yourself. If you dispatch a
  subagent, re-run its checks before believing them. Prove real seams end-to-end — run the CLI, hit
  the real path — not just unit-green.
- **Empirical over hypothetical.** Ship what's proven. Don't invent a lossy "smaller" variant of a
  battle-tested thing just to feel incremental.
- **Own mistakes plainly** and fix them; don't paper over.
- **Terse, outcome-first.** Lead with what changed and whether it works.

## Code standards (mandatory, whole repo)

Two hard rules govern **all** TypeScript here — read them before writing code:

- **[TypeScript patterns](.claude/rules/typescript-patterns.md)** — named-object params on every
  1+-arg function (with the listed exceptions), no `any`, explicit return types, `@param`/`@returns`.
- **[Testing](.claude/rules/testing.md)** — pure functions, zero mocks, no conditionals in assertions,
  falsifiable + exact assertions.

These apply to the entire repo, always — not just new code. A change that diverges is a defect.

@.claude/rules/typescript-patterns.md
@.claude/rules/testing.md

## Toolchain

Yarn 4 (Berry), pinned via the `packageManager` field and resolved by Corepack/proto. `node-modules`
linker (not PnP) for maximum tooling compatibility. Node version is pinned in `.nvmrc`.

```bash
yarn install                # deps
yarn slopweaver doctor      # smoke-test the CLI end-to-end
yarn format                 # apply Biome (code) + Prettier (docs) formatting in place
yarn lint                   # `slopweaver dev lint` — the whole static-analysis bar (see below)
yarn typecheck              # tsc --noEmit (must be clean)
yarn test:unit              # vitest (must pass)
yarn validate               # lint + typecheck + test:unit — the full local gate; run it before every push
```

`yarn lint` runs `slopweaver dev lint`, one door over every static-analysis check. It runs them ALL (no
short-circuit — one run tells you everything wrong) and exits non-zero if any failed:

- **Biome** (`biome.jsonc`) — the formatter of record for JS/TS/JSON (double quotes, semicolons, 2-space, LF,
  width 120), plus import organisation and a small set of critical bug rules. `yarn format` writes it.
- **Prettier** (`.prettierrc`) — formats only the doc formats Biome leaves alone (`.md`/`.yaml`/…); its
  `.prettierignore` hands all code/JSON to Biome so the two never fight.
- **oxlint** (`.oxlintrc.jsonc`) — fast syntactic AST/bug rules, zero warnings tolerated (`--deny-warnings`).
- **ESLint** (`eslint.config.js`) — the type-aware lane oxlint can't cover (`no-floating-promises`,
  `no-misused-promises`, switch-exhaustiveness, `only-throw-error`, ReDoS/sonarjs), plus the house rules as
  `no-restricted-syntax` selectors: no `?? ""`, no `isDirectInvocation`, no `process.argv[1]`, no `as any`/double
  casts. Run with `--max-warnings 0` — advisory `warn` severities are kept, but ANY warning fails the gate.
  Runs over `tsconfig.eslint.json`.
- **knip** (`knip.json`) — dead files / unused exports / unlisted deps.
- **constraints** (`yarn.config.cjs`) — every dependency exact-pinned; `packageManager` always set.
- **hygiene** + **door-coverage** — the public leak gate and the admit-door seam ratchet (see `docs/`).

`yarn validate` is the one-command local CI (the equivalent of the archive's `local-ci`): it's exactly what
the CI `build` job runs. Run it before every push (the pre-push hook does too — see below).

### Git hooks (lefthook)

`lefthook` installs two hooks automatically on `yarn install` (via the `prepare` script); config in `lefthook.yml`:

- **pre-commit** — auto-formats the _staged_ files (Biome for code/JSON, Prettier for docs) and re-stages
  them, so every commit is already formatted + import-sorted the way CI checks.
- **pre-push** — runs `yarn validate` (the full gate), so a red tree never reaches CI. Bypass in a genuine
  emergency with `git push --no-verify`.

TypeScript is pinned to the latest **5.9** (not 7.x): typescript-eslint peer-requires TypeScript `<6.1`, so
staying on 5.9 keeps the full type-aware ESLint lane. `tsconfig.json` is the strict config ported from the
archive — `strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
`noImplicitReturns`, `noUnusedLocals`/`noUnusedParameters`, `allowUnreachableCode:false`, `allowUnusedLabels:false`.
Standalone toolchain — TypeScript + vitest + Biome + Prettier + oxlint + ESLint + knip + yarn constraints +
lefthook, no monorepo tooling.

## Pull requests

- One commit off the base branch.
- Open as a **draft** for the maintainer's review.
- Never merge or undraft without the maintainer.

**Description format — required for every PR** (skeleton in `.github/pull_request_template.md`):

- A horizontal row of [shields.io](https://shields.io) **flat** badges — include only those that
  apply: `CI` (linked to its run), `size`, `proof`, and `CodeRabbit` / `review` when relevant.
- `proof` is a **grade**: `bronze` = builds + tests/gate green (mechanical) · `silver` = a real seam
  exercised locally with captured evidence (e.g. a sanitised terminal screenshot) · `gold` =
  end-to-end against real data or a live preview.
- A `👉 Next` one-row callout stating what happens after merge.
- A **Problem / Solution / Proof** table. **Problem and Solution are each max 50 words.** Proof
  carries real evidence matching the proof grade.
- Keep the body **lean**: anything non-obvious or non-intuitive goes in an **inline review comment on
  the diff**, never in the description.
