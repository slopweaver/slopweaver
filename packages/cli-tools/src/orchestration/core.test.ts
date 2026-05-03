import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMonorepoRoot } from '../lib/paths.ts';
import {
  buildRuntimePlan,
  formatDryRunPlan,
  getModelCandidates,
  getProfile,
  interpolateTemplate,
  isSuccessfulReview,
  type ParsedChain,
  parseOrchestrationChain,
  resolveChainRelativePath,
  resolveProfileId,
  resolveRunSlug,
} from './core.ts';

function readChainFixture({ relativePath }: { relativePath: string }): ParsedChain {
  const repoRoot = findMonorepoRoot();
  const chainPath = path.join(repoRoot, relativePath);
  return parseOrchestrationChain({
    chainPath,
    markdown: fs.readFileSync(chainPath, 'utf8'),
  });
}

describe('orchestration core', () => {
  it('parses the public refactor example chain', () => {
    const chain = readChainFixture({
      relativePath: 'docs/orchestration/examples/refactor-example.md',
    });

    expect(chain.title).toBe('Refactor Example: Rename a Shared Utility Across Packages');
    expect(chain.variables['worktree']).toBe('refactor-rename-utility');
    expect(chain.steps[0]?.title).toBe('Initial Plan');
    expect(chain.steps[0]?.role).toBe('codex-plan');
    expect(chain.steps[0]?.promptTemplate).toContain('Investigate and plan the refactor');
    expect(chain.steps.some((step) => step.role === 'codex-review')).toBe(true);
  });

  it('uses a generic profile for every chain', () => {
    expect(resolveProfileId()).toBe('generic');
    expect(getProfile({ profileId: 'generic' }).implementationSlices).toHaveLength(1);
  });

  it('derives run slugs from the full chain path instead of the basename', () => {
    const repoRoot = '/repo/slopweaver';

    expect(
      resolveRunSlug({
        chainPath: '/repo/slopweaver/.claude/orchestration/other/refactor.md',
        repoRoot,
      }),
    ).toBe('claude-orchestration-other-refactor');

    expect(
      resolveRunSlug({
        chainPath: '/repo/slopweaver/.claude/orchestration/refactors/README.md',
        repoRoot,
      }),
    ).toBe('claude-orchestration-refactors-readme');

    expect(
      resolveChainRelativePath({
        chainPath: '/repo/slopweaver/docs/orchestration/examples/refactor-example.md',
        repoRoot,
      }),
    ).toBe(path.normalize('docs/orchestration/examples/refactor-example.md'));
  });

  it('builds executor-specific runtime plans and dry-runs', () => {
    const chain = readChainFixture({
      relativePath: 'docs/orchestration/examples/refactor-example.md',
    });
    const profile = getProfile({ profileId: 'generic' });

    expect(formatDryRunPlan({ chain, executor: 'codex-only', profile })).toBe(
      [
        'Chain: Refactor Example: Rename a Shared Utility Across Packages',
        'Executor: codex-only',
        'Profile: generic',
        'Phases:',
        '1. worktree bootstrap: refactor-rename-utility',
        '2. codex planning',
        '3. codex implementation',
        '4. pr creation',
        '5. codex review loop',
        '6. ci loop',
        '7. stop at human review and manual qa',
      ].join('\n'),
    );

    const hybridPlan = buildRuntimePlan({ chain, executor: 'hybrid', profile });
    expect(hybridPlan.worktreeName).toBe('refactor-rename-utility');
    expect(hybridPlan.executor).toBe('hybrid');
    expect(hybridPlan.phases).toContain('claude implementation');
  });

  it('interpolates prompt variables without mutating unknown placeholders', () => {
    const result = interpolateTemplate({
      template: 'Review {pr_url} in {worktree} and keep {unknown}.',
      variables: {
        pr_url: 'https://github.com/slopweaver/slopweaver/pull/123',
        worktree: 'refactor-rename-utility',
      },
    });

    expect(result).toBe(
      'Review https://github.com/slopweaver/slopweaver/pull/123 in refactor-rename-utility and keep {unknown}.',
    );
  });

  it('treats only the exact review success sentinels as a pass', () => {
    expect(isSuccessfulReview({ reviewOutput: 'LGTM - ready for local testing.' })).toBe(true);
    expect(isSuccessfulReview({ reviewOutput: 'REVIEW_STATUS: PASS' })).toBe(true);
    expect(isSuccessfulReview({ reviewOutput: 'lgtm maybe' })).toBe(false);
    expect(isSuccessfulReview({ reviewOutput: 'P1 issue found' })).toBe(false);
  });

  it('keeps planning on high reasoning and escalates implementation after repeated failures', () => {
    expect(getModelCandidates({ attempts: 0, kind: 'implementation' })).toEqual([
      { model: 'gpt-5.3-codex-spark', reasoning: 'low' },
      { model: 'gpt-5.4', reasoning: 'xhigh' },
    ]);

    expect(getModelCandidates({ attempts: 2, kind: 'implementation' })).toEqual([
      { model: 'gpt-5.4', reasoning: 'xhigh' },
      { model: 'gpt-5.3-codex-spark', reasoning: 'low' },
    ]);

    expect(getModelCandidates({ attempts: 0, kind: 'planning' })).toEqual([
      { model: 'gpt-5.4', reasoning: 'xhigh' },
      { model: 'gpt-5.3-codex-spark', reasoning: 'xhigh' },
    ]);
  });
});
