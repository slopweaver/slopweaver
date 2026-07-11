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
  repo and CI. It names no organisation. It detects generic leak *classes*: absolute home paths,
  token shapes, raw workspace-ID patterns.
- **Private denylist** — the actual org-specific words live only in `$SLOPWEAVER_HOME/hygiene-denylist.txt`,
  which is **never committed**. The gate reads it at runtime. This keeps the scanner from having to
  *contain* the very words it guards against.

A gitignored local `pre-push` hook runs the gate before anything leaves the machine. **Run the gate
before every push** and never weaken it to get a green.

## Porting from private sources

Parts of this engine were designed against private, internal codebases. When you port a design:
re-implement it in this repo's own clean idiom, re-skin every name, and keep the gate green. Port
the *design*, never the code or naming verbatim.

## How we work

- **Verify, don't trust.** Never report a check green you haven't run yourself. If you dispatch a
  subagent, re-run its checks before believing them. Prove real seams end-to-end — run the CLI, hit
  the real path — not just unit-green.
- **Empirical over hypothetical.** Ship what's proven. Don't invent a lossy "smaller" variant of a
  battle-tested thing just to feel incremental.
- **Own mistakes plainly** and fix them; don't paper over.
- **Terse, outcome-first.** Lead with what changed and whether it works.

## Toolchain

Yarn 4 (Berry), pinned via the `packageManager` field and resolved by Corepack/proto. `node-modules`
linker (not PnP) for maximum tooling compatibility. Node version is pinned in `.nvmrc`.

```bash
yarn install                # deps
yarn slopweaver doctor      # smoke-test the CLI end-to-end
yarn typecheck              # tsc --noEmit (must be clean)
yarn test:unit              # vitest (must pass)
yarn hygiene                # the public hygiene gate (must be clean)
```

Standalone toolchain: TypeScript + vitest + oxlint, no monorepo tooling.

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
