/**
 * Runtime configuration resolved from the environment — home directory, target repository, GitHub
 * token. All three follow the zero-config, own-your-data promise: sensible defaults, no file to edit.
 *
 * The token chain is **gh-first by design**: an explicit `GITHUB_TOKEN`/`GH_TOKEN` wins if set, but the
 * default path is the user's existing `gh` CLI login — so most users need no token at all. Nothing here
 * reads or writes secrets to disk.
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { err, ok, type Result } from './lib/result.js'

/** A GitHub repository coordinate. */
export interface Repository {
  readonly owner: string
  readonly repo: string
}

/**
 * The world-model home. `$SLOPWEAVER_HOME` if set, else `~/.slopweaver`. Everything on disk (the
 * corpus cache, the private hygiene denylist) lives under here; it never leaves the machine.
 *
 * @returns the absolute home directory path
 */
export function slopweaverHome(): string {
  const fromEnv = process.env.SLOPWEAVER_HOME
  return fromEnv != null && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.slopweaver')
}

/**
 * Parse an `owner/repo` out of a git remote URL. Tolerant of HTTPS, SSH, `ssh://`, and SSH **host
 * aliases** (e.g. `git@github-personal:owner/repo.git`) so a repo cloned through a per-account alias
 * still resolves.
 *
 * @param remoteUrl the raw `git remote get-url` output
 * @returns the parsed repository, or an error when it can't be shaped
 */
export function repositoryFromGitRemote({ remoteUrl }: { remoteUrl: string }): Result<Repository> {
  const url = remoteUrl.trim()
  const ssh = /^(?:ssh:\/\/)?git@[^:/]+[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  const match = ssh ?? https
  if (match == null || match[1] == null || match[2] == null) {
    return err([`could not parse owner/repo from git remote: ${remoteUrl}`])
  }
  return ok({ owner: match[1], repo: match[2] })
}

/**
 * Parse an explicit `owner/repo` string (the `--repo` flag).
 *
 * @param slug the `owner/repo` argument
 * @returns the parsed repository, or an error when malformed
 */
export function parseRepositorySlug({ slug }: { slug: string }): Result<Repository> {
  const parts = slug.trim().split('/')
  if (parts.length !== 2 || parts[0] == null || parts[1] == null || parts[0].length === 0 || parts[1].length === 0) {
    return err([`expected owner/repo, got: ${slug}`])
  }
  return ok({ owner: parts[0], repo: parts[1] })
}

/**
 * Resolve the target repo from `origin`'s git remote in `cwd`.
 *
 * @param cwd the checkout to read the remote from (defaults to the process cwd)
 * @returns the repository, or an error when there's no usable `origin` remote
 */
export function resolveRepository({ cwd = process.cwd() }: { cwd?: string } = {}): Result<Repository> {
  let remoteUrl: string
  try {
    remoteUrl = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return err(['no `origin` git remote found — pass --repo owner/repo, or run inside a git checkout'])
  }
  return repositoryFromGitRemote({ remoteUrl })
}

/** `gh auth token`, or undefined if the gh CLI is absent / not logged in. */
function tokenFromGhCli(): string | undefined {
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * The GitHub token, gh-first: an explicit `GITHUB_TOKEN`/`GH_TOKEN` wins, otherwise the `gh` CLI login.
 * Undefined means "unauthenticated" — fine for public repos (lower rate limits); the refresh verb hints
 * `gh auth login` when a private fetch 404/403s.
 *
 * @returns the token, or undefined when unauthenticated
 */
export function githubToken(): string | undefined {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (fromEnv != null && fromEnv.trim().length > 0) {
    return fromEnv.trim()
  }
  return tokenFromGhCli()
}
