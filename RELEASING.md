# Releasing

How SlopWeaver packages get to npm.

## One-time setup

Run these once per publishable package. Founder-only — agents can't do them.

### npm Trusted Publisher

Avoids storing a long-lived `NPM_TOKEN` secret in the repo. npm verifies the GitHub Actions OIDC token directly.

**Per-package, not account-level.** The package must already exist on npm before you can configure its trusted publisher (chicken-and-egg: for a brand-new package, do one local `pnpm publish` from your interactive `npm login` session first, then configure the trusted publisher for all subsequent CI publishes).

1. Sign in to [npmjs.com](https://npmjs.com) as the package owner.
2. Go directly to the package's settings: `https://www.npmjs.com/package/<package-name>/access` → **Settings** → **Trusted publishing** → **Add trusted publisher**.
   (If you're on the account-level "Access Tokens" page you're in the wrong place — that creates classic `NPM_TOKEN`s, which we're trying to avoid.)
3. Configure:
   - Publisher: **GitHub Actions**
   - Organization or user: `slopweaver`
   - Repository: `slopweaver`
   - Workflow filename: `release.yml` (just the filename, no path)
   - Environment name: `npm-publish` (must match the `environment:` value in the workflow)
4. The package's `package.json` `"repository"` field must **exactly match** the GitHub repo URL — `git+https://github.com/slopweaver/slopweaver.git` — or the trusted publisher save will silently mis-link.

### GitHub `npm-publish` environment

Adds a manual approval gate that blocks the entire `publish` job until a reviewer approves. The earlier `verify` job (format / lint / compile / test) runs ungated, so you'll see CI signal before the gate prompt appears.

1. Repo **Settings** → **Environments** → **New environment** → name `npm-publish`.
2. **Required reviewers** → add `@lachiejames`.
3. (Optional, recommended) restrict deployments to **selected branches and tags** → add tag pattern `v*.*.*`. The release workflow runs from the release tag's ref (`refs/tags/v1.2.3`), so a `v*.*.*` rule blocks any other ref from triggering a publish.

## Cutting a release

1. **Bump the version** in the publishable package(s):
   ```bash
   pnpm --filter <package-name> version <patch|minor|major>
   ```
2. **Open a release-prep PR** with the version bump on a worktree branch. Merge once green.
3. **Tag and push** from `main`:
   ```bash
   git checkout main && git pull
   git tag v<X.Y.Z>
   git push origin v<X.Y.Z>
   ```
4. **Draft the GitHub Release**: Releases → **Draft a new release** → pick the tag → **Generate release notes** → **Publish release**.
5. The `Release` workflow fires. Approve it in the `npm-publish` environment when the gate prompt appears in the Actions tab.
6. **Verify on npmjs.com** — the new version should show with a "Provenance" / verified-publisher badge.

## Rollback

npm's `unpublish` window is 72 hours and heavily restricted. The realistic recovery is `deprecate`:

```bash
npm deprecate @slopweaver/<package>@<version> "reason"
```

Then bump the version and publish a fix.
