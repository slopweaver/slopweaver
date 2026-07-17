# The dev gate + the state home

Two foundations every later slice builds on: one typed contract for everything the agent persists, and
one gate every PR must pass.

## The state home (`$SLOPWEAVER_HOME`)

Everything on disk lives under `$SLOPWEAVER_HOME` (default `~/.slopweaver`) and every path comes from ONE
place — [`src/stateHome.ts`](../src/stateHome.ts). No other module derives a home sub-path; a guard test
(`src/stateHome.guard.test.ts`) fails the build if one tries.

```
$SLOPWEAVER_HOME/
├── .home-version.json        # layout-version marker (for future migration)
├── corpus/                   # the medallion store: bronze → silver → gold + caches + .watermark.json
├── beliefs/                  # belief store (contents: later PRs)
├── ledgers/                  # append-only run logs (dev-gate log + diff live here)
├── identity.json             # cross-integration identity map (seeded from a template)
├── profile.json              # the persona/profile seed (seeded from a template)
├── hygiene-denylist.txt      # your private, uncommitted leak denylist
└── .cache/models/            # on-device embedding model weights (rebuildable)
```

- **`slopweaver init`** scaffolds this idempotently — it creates missing dirs and seeds the marker/seed
  files, and NEVER overwrites a file you've edited. It runs automatically on SessionStart and is safe to
  re-run. It is additive: it never touches any other state home you may keep for an unrelated tool.
- **`slopweaver doctor`** reports the home read-only: layout version, which parts exist/are empty, and
  whether `identity.json`/`profile.json` parse — never their contents.

## The gate (`slopweaver dev gate`)

One command, one non-zero exit, three composed checks (all run — one pass tells you everything that's wrong):

1. **hygiene** — the public leak-class scan + your private denylist (`src/hygiene/`).
2. **PR-format** — the PR-description schema (`src/prformat/`). A missing body is a failure, not a skip.
3. **eval-regression** — deterministic retrieval recall@k over the frozen fixture vs the frozen baseline's
   overall + per-cluster floors (`src/eval/regression.ts`; see [eval.md](./eval.md)).

It writes a JSONL run log (`ledgers/dev-gate.jsonl`) and the baseline↔candidate diff
(`ledgers/eval-regression.diff.json`) under the home. CI runs the **same** `yarn dev:gate` path on every PR.

```bash
yarn dev:gate                       # PR body from $PR_BODY (or --pr-body-file <path>)
yarn eval:rebaseline --write --reason "why the floor is moving"   # the ONLY way the floors change
```

The gate never moves its own baseline. Re-baselining is a separate, deliberate command that refuses
without `--write` + a `--reason`, and refuses in CI unless `SLOPWEAVER_ALLOW_REBASELINE_IN_CI=1`.

> Scope note: `dev gate` is the leak/format/regression bar. `yarn typecheck` + `yarn test:unit` stay the
> standard build steps (run in CI alongside the gate and in the local proof) — the gate does not re-run them.
