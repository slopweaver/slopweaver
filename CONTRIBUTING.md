# Contributing to SlopWeaver

Thanks for your interest. SlopWeaver is **pre-alpha** and built by one person — I appreciate contributions, but please read this before sending a PR so I can review it efficiently.

## Status check first

- v1.0.0 is in active scaffolding. Most packages and apps **don't exist yet** — see the [v1.0.0 roadmap](https://github.com/slopweaver/slopweaver/issues/2) for what's coming and in what order.
- The architecture is documented in [CLAUDE.md](CLAUDE.md). Skim it before contributing — it explains the package boundaries, dev principles, and what's intentionally NOT in scope for v1.

## First-time local setup

After `pnpm install`, run the environment health check:

```bash
pnpm cli doctor
```

This verifies your Node and pnpm versions, that port `60701` (the local API port) is free, and that the `~/.slopweaver/` data directory exists -- offering to create it for you. It's the fastest way to confirm your machine is ready before you touch any code. See [`packages/cli-tools/README.md`](packages/cli-tools/README.md#doctor) for sample output.

## How to engage

- **Questions, ideas, use-case discussion** → [GitHub Discussions](https://github.com/slopweaver/slopweaver/discussions). Not Issues.
- **Bug reports** → [Issues](https://github.com/slopweaver/slopweaver/issues/new/choose) using the bug-report template.
- **Feature requests** → [Issues](https://github.com/slopweaver/slopweaver/issues/new/choose) using the feature-request template. **Open the issue before writing code** so we can confirm scope/approach before you invest time.
- **Integration requests** → [Issues](https://github.com/slopweaver/slopweaver/issues/new/choose) using the integration-request template.
- **Security vulnerabilities** → privately, see [SECURITY.md](SECURITY.md).
- **Pull requests** → see below.

## Before sending a PR

For anything beyond a typo or doc fix:

1. Open an Issue or Discussion first to confirm the change is wanted.
2. Wait for a thumbs-up from a maintainer before writing code. Saves you wasted effort if scope is wrong.
3. Keep PRs **small and focused**. One concern per PR. Reviewable in one sitting (~500 lines max excluding generated/migration files).
4. Use the PR template — fill in "What this PR does", "Why", "Test plan".

## Code style

When code lands (early in the v1.0.0 roadmap):

- TypeScript strict mode. No `any` in production code; use `unknown` + type guards.
- Named object parameters for any function with 1+ args (per the project convention; explicit return types on exported functions).
- Tests for new features. Vitest for unit/component, Playwright for e2e (when the local UI exists).
- No NestJS imports inside `packages/*` — see [CLAUDE.md](CLAUDE.md).
- Direct imports between packages. No dependency-inversion abstractions until there's a real second implementation.

## PR review timeline

Best-effort, since I'm one person:

- New PR: I aim to acknowledge within 7 days
- First review feedback: within 14 days
- Substantial PRs (>500 lines, new package, new integration) may take longer

If you don't hear back within 14 days, please ping the PR with a polite reminder.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
