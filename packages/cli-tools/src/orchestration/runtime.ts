import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BLUE, GREEN, NC, YELLOW } from '../lib/colors.ts';
import { findMonorepoRoot, resolveWorktreesRoot } from '../lib/paths.ts';
import {
  buildCiDiagnosisPrompt,
  buildCiFixPrompt,
  buildImplementationPrompt,
  buildReviewFixPrompt,
  buildReviewPrompt,
  type ChainProfile,
  type ExecutorMode,
  formatDryRunPlan,
  getModelCandidates,
  getProfile,
  interpolateTemplate,
  isSuccessfulReview,
  looksLikeTransientModelFailure,
  type ModelSelection,
  type OrchestrationPhase,
  type ParsedChain,
  parseCodexJobId,
  parseOrchestrationChain,
  parsePullRequestNumber,
  parsePullRequestUrl,
  resolveChainPath,
  resolveChainRelativePath,
  resolveProfileId,
  resolveRunSlug,
  resolveWorktreeName,
} from './core.ts';

export interface RunOrchestrationOptions {
  chainInputPath: string;
  dryRun: boolean;
  executor: ExecutorMode;
  notify: boolean;
  restart: boolean;
}

export interface PrepareOrchestrationOptions {
  chainInputPath: string;
  executor: ExecutorMode;
  restart: boolean;
}

export interface LauncherManifest {
  chainPath: string;
  chainTitle: string;
  executor: ExecutorMode;
  planFollowUpPromptFiles: string[];
  planInitialPromptFile: string | null;
  reviewPromptTemplateFile: string | null;
  runDirectory: string;
  stateFilePath: string;
  worktreePath: string;
  worktreeStatusSummary: string;
}

export interface RunState {
  branchName: string | null;
  chainPath: string;
  chainTitle: string;
  ciAttempts: number;
  completedSlices: string[];
  executor: ExecutorMode;
  ignoredWorktreeRelativePaths: string[];
  implementationAttempts: Record<string, number>;
  implementationOutputs: Record<string, string>;
  lastReviewOutput: string | null;
  phase: OrchestrationPhase;
  plannerOutputs: Record<string, string>;
  prUrl: string | null;
  profileId: ChainProfile['id'];
  reviewAttempts: number;
  reviewOutputs: string[];
  runSlug: string;
  worktreePath: string;
}

export interface RunOrchestrationEnvironment {
  awaitCodexTurn(args: { cwd: string; jobId: string }): string;
  closeCodexJob(args: { cwd: string; jobId: string }): void;
  commitAll(args: { cwd: string; ignoredPaths: string[]; message: string }): boolean;
  createOrReusePr(args: { body: string; cwd: string; title: string }): string;
  ensureWorktree(args: { repoRoot: string; worktreeName: string }): string;
  getBranchName(args: { cwd: string }): string;
  getLatestCiRunId(args: { branchName: string; cwd: string }): string | null;
  getWorktreeStatus(args: { cwd: string }): string[];
  hasDependencies(args: { cwd: string }): boolean;
  installDependencies(args: { cwd: string }): void;
  notify(args: { body: string; enabled: boolean; title: string }): void;
  pushBranch(args: { cwd: string }): void;
  sendCodexInput(args: { cwd: string; jobId: string; prompt: string }): void;
  startCodexJob(args: {
    cwd: string;
    model: string;
    notifyOnComplete: boolean;
    prompt: string;
    reasoning: ModelSelection['reasoning'];
    sandbox: 'read-only' | 'workspace-write';
  }): string;
  syncEnvFiles(args: { repoRoot: string; worktreePath: string }): void;
  watchCi(args: { cwd: string }): { output: string; success: boolean };
}

const STATE_FILENAME = 'state.json';
const FINAL_PLAN_FILENAME = 'final-plan.md';
const HYBRID_INITIAL_PLAN_PROMPT_FILENAME = 'hybrid-plan-initial.prompt.md';
const HYBRID_REVIEW_PROMPT_FILENAME = 'hybrid-review.prompt.md';
const HYBRID_SEND_PROMPT_PREFIX = 'hybrid-plan-send';

function getCodexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
}

function getRunDirectory({ runSlug }: { runSlug: string }): string {
  return path.join(getCodexHome(), 'orchestration-runs', runSlug);
}

function getStateFilePath({ runDirectory }: { runDirectory: string }): string {
  return path.join(runDirectory, STATE_FILENAME);
}

function getArtifactsDirectory({ runDirectory }: { runDirectory: string }): string {
  return path.join(runDirectory, 'artifacts');
}

function getArtifactPath({
  filename,
  runDirectory,
}: {
  filename: string;
  runDirectory: string;
}): string {
  return path.join(getArtifactsDirectory({ runDirectory }), filename);
}

function getDefaultState({
  chain,
  executor,
  profile,
  runSlug,
  worktreePath,
}: {
  chain: ParsedChain;
  executor: ExecutorMode;
  profile: ChainProfile;
  runSlug: string;
  worktreePath: string;
}): RunState {
  return {
    branchName: null,
    chainPath: chain.chainPath,
    chainTitle: chain.title,
    ciAttempts: 0,
    completedSlices: [],
    executor,
    ignoredWorktreeRelativePaths: [],
    implementationAttempts: {},
    implementationOutputs: {},
    lastReviewOutput: null,
    phase: 'initial',
    plannerOutputs: {},
    profileId: profile.id,
    prUrl: null,
    reviewAttempts: 0,
    reviewOutputs: [],
    runSlug,
    worktreePath,
  };
}

function ensureRunDirectories({ runDirectory }: { runDirectory: string }): void {
  fs.mkdirSync(getArtifactsDirectory({ runDirectory }), { recursive: true });
}

function loadState({
  chain,
  executor,
  profile,
  runDirectory,
  runSlug,
  worktreePath,
}: {
  chain: ParsedChain;
  executor: ExecutorMode;
  profile: ChainProfile;
  runDirectory: string;
  runSlug: string;
  worktreePath: string;
}): RunState {
  const stateFilePath = getStateFilePath({ runDirectory });
  if (!fs.existsSync(stateFilePath)) {
    return getDefaultState({ chain, executor, profile, runSlug, worktreePath });
  }

  const parsedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as Partial<RunState> & {
    slug?: string;
  };
  const defaultState = getDefaultState({ chain, executor, profile, runSlug, worktreePath });
  return {
    ...defaultState,
    ...parsedState,
    executor: parsedState.executor ?? executor,
    ignoredWorktreeRelativePaths: parsedState.ignoredWorktreeRelativePaths ?? [],
    runSlug: parsedState.runSlug ?? parsedState.slug ?? runSlug,
    worktreePath: parsedState.worktreePath ?? worktreePath,
  };
}

function saveState({ runDirectory, state }: { runDirectory: string; state: RunState }): void {
  ensureRunDirectories({ runDirectory });
  fs.writeFileSync(getStateFilePath({ runDirectory }), `${JSON.stringify(state, null, 2)}\n`);
}

function writeArtifact({
  filename,
  runDirectory,
  value,
}: {
  filename: string;
  runDirectory: string;
  value: string;
}): string {
  const artifactPath = getArtifactPath({ filename, runDirectory });
  ensureRunDirectories({ runDirectory });
  fs.writeFileSync(artifactPath, value.endsWith('\n') ? value : `${value}\n`);
  return artifactPath;
}

function readArtifact({
  filename,
  runDirectory,
}: {
  filename: string;
  runDirectory: string;
}): string | null {
  const artifactPath = getArtifactPath({ filename, runDirectory });
  if (!fs.existsSync(artifactPath)) {
    return null;
  }
  return fs.readFileSync(artifactPath, 'utf8');
}

function bumpRetryCount({ key, state }: { key: string; state: RunState }): number {
  const nextAttempt = (state.implementationAttempts[key] ?? 0) + 1;
  state.implementationAttempts[key] = nextAttempt;
  return nextAttempt;
}

function buildPrBody({
  chainPath,
  chainTitle,
  executor,
}: {
  chainPath: string;
  chainTitle: string;
  executor: ExecutorMode;
}): string {
  return [
    '## Summary',
    `- Automated via shared orchestration core (${executor})`,
    `- Chain: \`${chainPath}\``,
    `- Scope: ${chainTitle}`,
    '',
    '## Test plan',
    '- [ ] Orchestration-generated changes reviewed',
    '- [ ] CI green',
    '- [ ] Manual staging QA still required',
  ].join('\n');
}

function parseStatusPath({ line }: { line: string }): string | null {
  if (line.length < 4) {
    return null;
  }

  const rawPath = line.slice(3).trim();
  if (rawPath.length === 0) {
    return null;
  }

  if (rawPath.includes(' -> ')) {
    const segments = rawPath.split(' -> ');
    return segments.at(-1) ?? rawPath;
  }

  return rawPath;
}

function getRelevantWorktreeStatus({
  env,
  state,
}: {
  env: RunOrchestrationEnvironment;
  state: RunState;
}): string[] {
  const ignoredPaths = new Set(
    state.ignoredWorktreeRelativePaths.map((ignoredPath) => path.normalize(ignoredPath)),
  );
  return env.getWorktreeStatus({ cwd: state.worktreePath }).filter((line) => {
    const parsedPath = parseStatusPath({ line });
    if (!parsedPath) {
      return true;
    }

    return !ignoredPaths.has(path.normalize(parsedPath));
  });
}

function assertWorktreeIsReady({
  env,
  state,
}: {
  env: RunOrchestrationEnvironment;
  state: RunState;
}): void {
  const relevantStatus = getRelevantWorktreeStatus({ env, state });
  const hasMergeConflicts = relevantStatus.some(
    (line) => line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('DD '),
  );
  if (hasMergeConflicts) {
    throw new Error(`Worktree has merge conflicts: ${state.worktreePath}`);
  }

  if (relevantStatus.length > 0) {
    throw new Error(`Worktree is dirty: ${state.worktreePath}`);
  }
}

function syncChainFileIntoWorktree({
  chainPath,
  repoRoot,
  worktreePath,
}: {
  chainPath: string;
  repoRoot: string;
  worktreePath: string;
}): string | null {
  const relativeChainPath = resolveChainRelativePath({ chainPath, repoRoot });
  if (relativeChainPath === null) {
    return null;
  }

  const destinationPath = path.join(worktreePath, relativeChainPath);
  if (path.normalize(destinationPath) === path.normalize(chainPath)) {
    return null;
  }

  const sourceContents = fs.readFileSync(chainPath, 'utf8');
  const destinationExists = fs.existsSync(destinationPath);
  const destinationContents = destinationExists ? fs.readFileSync(destinationPath, 'utf8') : null;
  if (destinationContents === sourceContents) {
    return relativeChainPath;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, sourceContents);
  return relativeChainPath;
}

function describeNextAction({ state }: { state: RunState }): string {
  switch (state.phase) {
    case 'initial':
      return 'start planning';
    case 'planning':
      return 'resume planning';
    case 'implementation':
      return 'resume implementation';
    case 'pr':
      return 'create or reuse PR';
    case 'review':
      return 'resume review loop';
    case 'ci':
      return 'resume ci loop';
    case 'awaiting_manual_qa':
      return 'wait for human review and manual QA';
  }
}

function buildStateSummary({ state }: { state: RunState }): string {
  const completedSlices =
    state.completedSlices.length > 0 ? state.completedSlices.join(', ') : 'none';
  return [
    `Executor: ${state.executor}`,
    `Phase: ${state.phase}`,
    `Worktree: ${state.worktreePath}`,
    `PR: ${state.prUrl ?? '(not created)'}`,
    `Completed slices: ${completedSlices}`,
    `Next action: ${describeNextAction({ state })}`,
  ].join('\n');
}

function bootstrapRunState({
  env,
  repoRoot,
  state,
  worktreeName,
}: {
  env: RunOrchestrationEnvironment;
  repoRoot: string;
  state: RunState;
  worktreeName: string;
}): void {
  state.worktreePath = env.ensureWorktree({ repoRoot, worktreeName });
  env.syncEnvFiles({ repoRoot, worktreePath: state.worktreePath });

  const syncedChainPath = syncChainFileIntoWorktree({
    chainPath: state.chainPath,
    repoRoot,
    worktreePath: state.worktreePath,
  });
  if (syncedChainPath !== null && !state.ignoredWorktreeRelativePaths.includes(syncedChainPath)) {
    state.ignoredWorktreeRelativePaths.push(syncedChainPath);
  }

  if (!env.hasDependencies({ cwd: state.worktreePath })) {
    env.installDependencies({ cwd: state.worktreePath });
  }

  state.branchName = env.getBranchName({ cwd: state.worktreePath });
  assertWorktreeIsReady({ env, state });
}

function runCodexPromptWithFallback({
  cwd,
  env,
  kind,
  notifyOnComplete,
  prompt,
  retryKey,
  runDirectory,
  sandbox,
  state,
}: {
  cwd: string;
  env: RunOrchestrationEnvironment;
  kind: 'diagnosis' | 'implementation' | 'planning' | 'review';
  notifyOnComplete: boolean;
  prompt: string;
  retryKey: string;
  runDirectory: string;
  sandbox: 'read-only' | 'workspace-write';
  state: RunState;
}): string {
  const attemptCount = bumpRetryCount({ key: retryKey, state }) - 1;
  const candidates = getModelCandidates({ attempts: attemptCount, kind });
  let lastError = '';

  for (const candidate of candidates) {
    let jobId: string | null = null;

    try {
      const startOutput = env.startCodexJob({
        cwd,
        model: candidate.model,
        notifyOnComplete,
        prompt,
        reasoning: candidate.reasoning,
        sandbox,
      });
      jobId = parseCodexJobId({ output: startOutput });
      const output = env.awaitCodexTurn({ cwd, jobId });
      env.closeCodexJob({ cwd, jobId });
      jobId = null;

      if (looksLikeTransientModelFailure({ output })) {
        lastError = output;
        continue;
      }

      writeArtifact({
        filename: `${retryKey}-${candidate.model}.md`,
        runDirectory,
        value: output,
      });
      return output;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!looksLikeTransientModelFailure({ output: lastError })) {
        throw error;
      }
    } finally {
      if (jobId !== null) {
        env.closeCodexJob({ cwd, jobId });
      }
    }
  }

  throw new Error(`All model attempts failed for ${retryKey}.\n${lastError}`);
}

function runPlanningConversationWithFallback({
  chain,
  env,
  runDirectory,
  state,
}: {
  chain: ParsedChain;
  env: RunOrchestrationEnvironment;
  runDirectory: string;
  state: RunState;
}): { finalPlan: string; initialPlan: string } {
  const planStep = chain.steps.find((step) => step.role === 'codex-plan');
  if (!planStep?.promptTemplate) {
    throw new Error(`Missing codex-plan prompt in chain: ${chain.chainPath}`);
  }

  const sendSteps = chain.steps.filter(
    (step) => step.role === 'codex-send' && step.promptTemplate !== null,
  );
  const initialPrompt = interpolateTemplate({
    template: planStep.promptTemplate,
    variables: chain.variables,
  });
  const attemptCount = bumpRetryCount({ key: 'planner-main', state }) - 1;
  const candidates = getModelCandidates({ attempts: attemptCount, kind: 'planning' });
  let lastError = '';

  for (const candidate of candidates) {
    let jobId: string | null = null;

    try {
      const startOutput = env.startCodexJob({
        cwd: state.worktreePath,
        model: candidate.model,
        notifyOnComplete: false,
        prompt: initialPrompt,
        reasoning: candidate.reasoning,
        sandbox: 'read-only',
      });
      jobId = parseCodexJobId({ output: startOutput });

      const initialPlan = env.awaitCodexTurn({ cwd: state.worktreePath, jobId });
      if (looksLikeTransientModelFailure({ output: initialPlan })) {
        lastError = initialPlan;
        env.closeCodexJob({ cwd: state.worktreePath, jobId });
        jobId = null;
        continue;
      }

      writeArtifact({
        filename: `planner-main-step-0-${candidate.model}.md`,
        runDirectory,
        value: initialPlan,
      });

      let finalPlan = initialPlan;
      const activeJobId = jobId;
      sendSteps.forEach((step, index) => {
        const prompt = interpolateTemplate({
          template: step.promptTemplate ?? '',
          variables: chain.variables,
        });
        env.sendCodexInput({ cwd: state.worktreePath, jobId: activeJobId, prompt });
        finalPlan = env.awaitCodexTurn({ cwd: state.worktreePath, jobId: activeJobId });
        if (looksLikeTransientModelFailure({ output: finalPlan })) {
          throw new Error(finalPlan);
        }

        writeArtifact({
          filename: `planner-main-step-${index + 1}-${candidate.model}.md`,
          runDirectory,
          value: finalPlan,
        });
      });

      env.closeCodexJob({ cwd: state.worktreePath, jobId });
      jobId = null;
      return { finalPlan, initialPlan };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!looksLikeTransientModelFailure({ output: lastError })) {
        throw error;
      }
    } finally {
      if (jobId !== null) {
        env.closeCodexJob({ cwd: state.worktreePath, jobId });
      }
    }
  }

  throw new Error(`All model attempts failed for planner-main.\n${lastError}`);
}

function runPlanningPhase({
  chain,
  env,
  runDirectory,
  state,
}: {
  chain: ParsedChain;
  env: RunOrchestrationEnvironment;
  runDirectory: string;
  state: RunState;
}): string {
  state.phase = 'planning';
  const cachedPlan = readArtifact({ filename: FINAL_PLAN_FILENAME, runDirectory });
  if (cachedPlan) {
    return cachedPlan;
  }

  const planningResult = runPlanningConversationWithFallback({ chain, env, runDirectory, state });
  writeArtifact({ filename: FINAL_PLAN_FILENAME, runDirectory, value: planningResult.finalPlan });
  state.plannerOutputs['planner-main'] = planningResult.initialPlan;
  return planningResult.finalPlan;
}

function runImplementationPhase({
  env,
  finalPlan,
  profile,
  runDirectory,
  state,
}: {
  env: RunOrchestrationEnvironment;
  finalPlan: string;
  profile: ChainProfile;
  runDirectory: string;
  state: RunState;
}): void {
  state.phase = 'implementation';

  profile.implementationSlices.forEach((slice) => {
    if (state.completedSlices.includes(slice.id)) {
      return;
    }

    const output = runCodexPromptWithFallback({
      cwd: state.worktreePath,
      env,
      kind: 'implementation',
      notifyOnComplete: false,
      prompt: buildImplementationPrompt({
        executor: state.executor,
        finalPlan,
        profile,
        slice,
      }),
      retryKey: slice.id,
      runDirectory,
      sandbox: 'workspace-write',
      state,
    });

    state.implementationOutputs[slice.id] = output;
    writeArtifact({ filename: `${slice.id}.md`, runDirectory, value: output });

    if (
      env.commitAll({
        cwd: state.worktreePath,
        ignoredPaths: state.ignoredWorktreeRelativePaths,
        message: slice.commitMessage,
      })
    ) {
      state.completedSlices.push(slice.id);
      return;
    }

    state.completedSlices.push(slice.id);
  });
}

function ensurePr({
  chain,
  env,
  state,
}: {
  chain: ParsedChain;
  env: RunOrchestrationEnvironment;
  state: RunState;
}): string {
  state.phase = 'pr';
  if (state.prUrl) {
    return state.prUrl;
  }

  env.pushBranch({ cwd: state.worktreePath });
  const prUrl = env.createOrReusePr({
    body: buildPrBody({
      chainPath: chain.chainPath,
      chainTitle: chain.title,
      executor: state.executor,
    }),
    cwd: state.worktreePath,
    title: chain.title,
  });
  state.prUrl = prUrl;
  return prUrl;
}

function runReviewPhase({
  chain,
  env,
  finalPlan,
  runDirectory,
  state,
}: {
  chain: ParsedChain;
  env: RunOrchestrationEnvironment;
  finalPlan: string;
  runDirectory: string;
  state: RunState;
}): void {
  state.phase = 'review';
  const reviewStep = chain.steps.find((step) => step.role === 'codex-review');
  if (!reviewStep?.promptTemplate || !state.prUrl) {
    return;
  }

  for (;;) {
    const reviewOutput = runCodexPromptWithFallback({
      cwd: state.worktreePath,
      env,
      kind: 'review',
      notifyOnComplete: false,
      prompt: buildReviewPrompt({
        prUrl: state.prUrl,
        stepPrompt: reviewStep.promptTemplate,
        variables: chain.variables,
      }),
      retryKey: `review-${state.reviewAttempts + 1}`,
      runDirectory,
      sandbox: 'read-only',
      state,
    });

    state.reviewAttempts += 1;
    state.reviewOutputs.push(reviewOutput);
    state.lastReviewOutput = reviewOutput;
    writeArtifact({
      filename: `review-${state.reviewAttempts}.md`,
      runDirectory,
      value: reviewOutput,
    });

    if (isSuccessfulReview({ reviewOutput })) {
      return;
    }

    const fixOutput = runCodexPromptWithFallback({
      cwd: state.worktreePath,
      env,
      kind: 'implementation',
      notifyOnComplete: false,
      prompt: buildReviewFixPrompt({
        executor: state.executor,
        finalPlan,
        reviewOutput,
      }),
      retryKey: 'review-fix',
      runDirectory,
      sandbox: 'workspace-write',
      state,
    });

    writeArtifact({
      filename: `review-fix-${state.reviewAttempts}.md`,
      runDirectory,
      value: fixOutput,
    });
    env.commitAll({
      cwd: state.worktreePath,
      ignoredPaths: state.ignoredWorktreeRelativePaths,
      message: `fix: address codex review findings ${state.reviewAttempts}`,
    });
    env.pushBranch({ cwd: state.worktreePath });
  }
}

function runCiPhase({
  env,
  finalPlan,
  runDirectory,
  state,
}: {
  env: RunOrchestrationEnvironment;
  finalPlan: string;
  runDirectory: string;
  state: RunState;
}): void {
  state.phase = 'ci';

  for (;;) {
    const ciResult = env.watchCi({ cwd: state.worktreePath });
    state.ciAttempts += 1;
    writeArtifact({
      filename: `ci-watch-${state.ciAttempts}.md`,
      runDirectory,
      value: ciResult.output,
    });

    if (ciResult.success) {
      return;
    }

    const latestRunId =
      state.branchName === null
        ? null
        : env.getLatestCiRunId({ branchName: state.branchName, cwd: state.worktreePath });
    if (latestRunId === null) {
      throw new Error('CI failed but no GitHub run id could be resolved for diagnosis.');
    }

    const diagnosisOutput = runCodexPromptWithFallback({
      cwd: state.worktreePath,
      env,
      kind: 'diagnosis',
      notifyOnComplete: false,
      prompt: buildCiDiagnosisPrompt({
        prNumber: state.prUrl ? parsePullRequestNumber({ prUrl: state.prUrl }) : null,
        runId: latestRunId,
      }),
      retryKey: `ci-diagnosis-${state.ciAttempts}`,
      runDirectory,
      sandbox: 'read-only',
      state,
    });

    writeArtifact({
      filename: `ci-diagnosis-${state.ciAttempts}.md`,
      runDirectory,
      value: diagnosisOutput,
    });

    const fixOutput = runCodexPromptWithFallback({
      cwd: state.worktreePath,
      env,
      kind: 'implementation',
      notifyOnComplete: false,
      prompt: buildCiFixPrompt({
        diagnosisOutput,
        executor: state.executor,
        finalPlan,
      }),
      retryKey: 'ci-fix',
      runDirectory,
      sandbox: 'workspace-write',
      state,
    });

    writeArtifact({ filename: `ci-fix-${state.ciAttempts}.md`, runDirectory, value: fixOutput });
    env.commitAll({
      cwd: state.worktreePath,
      ignoredPaths: state.ignoredWorktreeRelativePaths,
      message: `fix: address ci failures ${state.ciAttempts}`,
    });
    env.pushBranch({ cwd: state.worktreePath });
  }
}

function buildLauncherManifest({
  chain,
  executor,
  runDirectory,
  state,
}: {
  chain: ParsedChain;
  executor: ExecutorMode;
  runDirectory: string;
  state: RunState;
}): LauncherManifest {
  const planStep = chain.steps.find((step) => step.role === 'codex-plan');
  const sendSteps = chain.steps.filter(
    (step) => step.role === 'codex-send' && step.promptTemplate !== null,
  );
  const reviewStep = chain.steps.find((step) => step.role === 'codex-review');

  const planInitialPromptFile =
    planStep?.promptTemplate === undefined || planStep.promptTemplate === null
      ? null
      : writeArtifact({
          filename: HYBRID_INITIAL_PLAN_PROMPT_FILENAME,
          runDirectory,
          value: interpolateTemplate({
            template: planStep.promptTemplate,
            variables: chain.variables,
          }),
        });

  const planFollowUpPromptFiles = sendSteps.map((step, index) =>
    writeArtifact({
      filename: `${HYBRID_SEND_PROMPT_PREFIX}-${index + 1}.prompt.md`,
      runDirectory,
      value: interpolateTemplate({
        template: step.promptTemplate ?? '',
        variables: chain.variables,
      }),
    }),
  );

  const reviewPromptTemplateFile =
    reviewStep?.promptTemplate === undefined || reviewStep.promptTemplate === null
      ? null
      : writeArtifact({
          filename: HYBRID_REVIEW_PROMPT_FILENAME,
          runDirectory,
          value: reviewStep.promptTemplate,
        });

  return {
    chainPath: chain.chainPath,
    chainTitle: chain.title,
    executor,
    planFollowUpPromptFiles,
    planInitialPromptFile,
    reviewPromptTemplateFile,
    runDirectory,
    stateFilePath: getStateFilePath({ runDirectory }),
    worktreePath: state.worktreePath,
    worktreeStatusSummary: buildStateSummary({ state }),
  };
}

function logResumeState({
  hasExistingState,
  state,
}: {
  hasExistingState: boolean;
  state: RunState;
}): void {
  if (!hasExistingState || state.phase === 'initial') {
    return;
  }

  console.log(`${YELLOW}Resuming orchestration state:${NC}`);
  console.log(buildStateSummary({ state }));
  console.log('');
}

function resolveChainContext({ chainInputPath }: { chainInputPath: string }): {
  chain: ParsedChain;
  profile: ChainProfile;
  repoRoot: string;
  runDirectory: string;
  runSlug: string;
  stateFilePath: string;
  worktreePath: string;
  worktreeName: string;
} {
  const repoRoot = findMonorepoRoot();
  const worktreesRoot = resolveWorktreesRoot({ repoRoot });
  const chainPath = resolveChainPath({ inputPath: chainInputPath, repoRoot });
  const markdown = fs.readFileSync(chainPath, 'utf8');
  const chain = parseOrchestrationChain({ chainPath, markdown });
  const profile = getProfile({ profileId: resolveProfileId() });
  const worktreeName = resolveWorktreeName({ chain });
  const worktreePath = path.join(worktreesRoot, worktreeName);
  const runSlug = resolveRunSlug({ chainPath, repoRoot });
  const runDirectory = getRunDirectory({ runSlug });

  return {
    chain,
    profile,
    repoRoot,
    runDirectory,
    runSlug,
    stateFilePath: getStateFilePath({ runDirectory }),
    worktreeName,
    worktreePath,
  };
}

export async function prepareOrchestration({
  env = createDefaultEnvironment(),
  options,
}: {
  env?: RunOrchestrationEnvironment | undefined;
  options: PrepareOrchestrationOptions;
}): Promise<void> {
  const { chain, runDirectory, stateFilePath, runSlug, worktreePath, worktreeName, repoRoot } =
    resolveChainContext({
      chainInputPath: options.chainInputPath,
    });

  if (options.restart && fs.existsSync(runDirectory)) {
    fs.rmSync(runDirectory, { force: true, recursive: true });
  }
  const hasExistingState = !options.restart && fs.existsSync(stateFilePath);
  const state = loadState({
    chain,
    executor: options.executor,
    profile: getProfile({ profileId: resolveProfileId() }),
    runDirectory,
    runSlug,
    worktreePath,
  });

  ensureRunDirectories({ runDirectory });
  state.executor = options.executor;
  bootstrapRunState({ env, repoRoot, state, worktreeName });
  saveState({ runDirectory, state });
  logResumeState({ hasExistingState, state });

  const manifest = buildLauncherManifest({
    chain,
    executor: options.executor,
    runDirectory,
    state,
  });
  const manifestPath = writeArtifact({
    filename: 'launcher-manifest.json',
    runDirectory,
    value: JSON.stringify(manifest, null, 2),
  });

  console.log(`${GREEN}Prepared shared orchestration core for ${options.executor}.${NC}`);
  console.log(`${BLUE}Worktree:${NC} ${state.worktreePath}`);
  console.log(`${BLUE}State:${NC} ${stateFilePath}`);
  console.log(`${BLUE}Manifest:${NC} ${manifestPath}`);
  if (manifest.planInitialPromptFile !== null) {
    console.log(`${BLUE}Planning prompt:${NC} ${manifest.planInitialPromptFile}`);
  }
  if (manifest.planFollowUpPromptFiles.length > 0) {
    console.log(`${BLUE}Planning follow-ups:${NC}`);
    manifest.planFollowUpPromptFiles.forEach((promptFile) => {
      console.log(`- ${promptFile}`);
    });
  }
  if (manifest.reviewPromptTemplateFile !== null) {
    console.log(`${BLUE}Review prompt template:${NC} ${manifest.reviewPromptTemplateFile}`);
  }
}

export async function runOrchestration({
  env = createDefaultEnvironment(),
  options,
}: {
  env?: RunOrchestrationEnvironment | undefined;
  options: RunOrchestrationOptions;
}): Promise<void> {
  const executor = options.executor;
  const {
    chain,
    profile,
    repoRoot,
    runDirectory,
    stateFilePath,
    runSlug,
    worktreePath,
    worktreeName,
  } = resolveChainContext({
    chainInputPath: options.chainInputPath,
  });

  if (options.restart && fs.existsSync(runDirectory)) {
    fs.rmSync(runDirectory, { force: true, recursive: true });
  }
  const hasExistingState = !options.restart && fs.existsSync(stateFilePath);
  const state = loadState({
    chain,
    executor,
    profile,
    runDirectory,
    runSlug,
    worktreePath,
  });

  if (options.dryRun) {
    console.log(formatDryRunPlan({ chain, executor, profile }));
    return;
  }

  ensureRunDirectories({ runDirectory });
  state.executor = executor;
  bootstrapRunState({ env, repoRoot, state, worktreeName });
  saveState({ runDirectory, state });
  logResumeState({ hasExistingState, state });

  if (state.phase === 'awaiting_manual_qa') {
    console.log(
      `${YELLOW}Run already paused at manual QA:${NC} ${GREEN}${state.prUrl ?? '(no PR URL)'}${NC}`,
    );
    console.log(buildStateSummary({ state }));
    return;
  }

  const finalPlan = runPlanningPhase({ chain, env, runDirectory, state });
  saveState({ runDirectory, state });

  runImplementationPhase({ env, finalPlan, profile, runDirectory, state });
  saveState({ runDirectory, state });

  ensurePr({ chain, env, state });
  saveState({ runDirectory, state });

  runReviewPhase({ chain, env, finalPlan, runDirectory, state });
  saveState({ runDirectory, state });

  runCiPhase({ env, finalPlan, runDirectory, state });
  state.phase = 'awaiting_manual_qa';
  saveState({ runDirectory, state });

  env.notify({
    body: `Orchestration paused for human review and staging QA.\n${state.prUrl ?? 'PR URL unavailable'}`,
    enabled: options.notify,
    title: 'Orchestration ready',
  });

  console.log('');
  console.log(`${GREEN}Orchestration complete.${NC}`);
  console.log(`${BLUE}PR:${NC} ${state.prUrl ?? '(not created)'}`);
  console.log(`${BLUE}State:${NC} ${stateFilePath}`);
  console.log(`${YELLOW}Next:${NC} final review + manual staging QA`);
}

function runProcess({
  args,
  captureOutput = true,
  cwd,
  env,
  command,
}: {
  args: string[];
  captureOutput?: boolean | undefined;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
}): { exitCode: number; output: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: captureOutput ? 'pipe' : 'inherit',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    exitCode: result.status ?? 1,
    output,
  };
}

function getAugmentedPathEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  return {
    ...process.env,
    PATH: `${path.join(home, '.codex-orchestrator', 'bin')}:${path.join(home, '.bun', 'bin')}:${process.env['PATH'] ?? ''}`,
  };
}

function collectEnvFiles({
  currentDir,
  foundFiles,
}: {
  currentDir: string;
  foundFiles: string[];
}): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      entry.name === '.pnpm-store' ||
      entry.name === '.turbo'
    ) {
      continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectEnvFiles({ currentDir: fullPath, foundFiles });
      continue;
    }
    if (entry.isFile() && entry.name.startsWith('.env')) {
      foundFiles.push(fullPath);
    }
  }
}

export function createDefaultEnvironment(): RunOrchestrationEnvironment {
  return {
    awaitCodexTurn: ({ cwd, jobId }) => {
      const result = runProcess({
        args: ['await-turn', jobId],
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      });
      if (result.exitCode !== 0) {
        throw new Error(result.output);
      }
      return result.output;
    },
    closeCodexJob: ({ cwd, jobId }) => {
      runProcess({
        args: ['send', jobId, '/quit'],
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      });
    },
    commitAll: ({ cwd, ignoredPaths, message }) => {
      const status = runProcess({ args: ['status', '--short'], command: 'git', cwd });
      const relevantStatus = status.output
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .filter((line) => {
          const parsedPath = parseStatusPath({ line });
          if (parsedPath === null) {
            return true;
          }

          return !ignoredPaths.includes(parsedPath);
        });

      if (relevantStatus.length === 0) {
        return false;
      }

      const addArgs = ['add', '-A', '--', '.'];
      ignoredPaths.forEach((ignoredPath) => {
        addArgs.push(`:(exclude)${ignoredPath}`);
      });

      const addResult = runProcess({
        args: addArgs,
        captureOutput: false,
        command: 'git',
        cwd,
      });
      if (addResult.exitCode !== 0) {
        throw new Error('Failed to stage changes before commit.');
      }

      const commitResult = runProcess({
        args: ['commit', '-m', message],
        captureOutput: false,
        command: 'git',
        cwd,
      });
      if (commitResult.exitCode !== 0) {
        throw new Error(`Failed to commit changes: ${message}`);
      }
      return true;
    },
    createOrReusePr: ({ body, cwd, title }) => {
      const existingPr = runProcess({
        args: ['pr', 'view', '--json', 'url', '--jq', '.url'],
        command: 'gh',
        cwd,
      });
      if (existingPr.exitCode === 0 && existingPr.output.trim()) {
        return existingPr.output.trim();
      }

      const createdPr = runProcess({
        args: ['pr', 'create', '--title', title, '--body', body],
        command: 'gh',
        cwd,
      });
      if (createdPr.exitCode !== 0) {
        throw new Error(createdPr.output);
      }
      return parsePullRequestUrl({ output: createdPr.output });
    },
    ensureWorktree: ({ repoRoot, worktreeName }) => {
      const worktreePath = path.join(resolveWorktreesRoot({ repoRoot }), worktreeName);
      if (fs.existsSync(worktreePath)) {
        return worktreePath;
      }

      const result = runProcess({
        args: ['cli', 'worktree-new', worktreeName],
        captureOutput: false,
        command: 'pnpm',
        cwd: repoRoot,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to create worktree ${worktreeName}`);
      }
      return worktreePath;
    },
    getBranchName: ({ cwd }) => {
      const result = runProcess({
        args: ['branch', '--show-current'],
        command: 'git',
        cwd,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to determine current branch for ${cwd}`);
      }
      return result.output.trim();
    },
    getLatestCiRunId: ({ branchName, cwd }) => {
      const result = runProcess({
        args: ['run', 'list', '--branch', branchName, '--limit', '1', '--json', 'databaseId'],
        command: 'gh',
        cwd,
      });
      if (result.exitCode !== 0) {
        return null;
      }

      const parsed = JSON.parse(result.output) as Array<{ databaseId?: number | null }>;
      const latest = parsed[0]?.databaseId;
      return latest === undefined || latest === null ? null : String(latest);
    },
    getWorktreeStatus: ({ cwd }) => {
      const result = runProcess({
        args: ['status', '--short'],
        command: 'git',
        cwd,
      });
      return result.output
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
    },
    hasDependencies: ({ cwd }) => fs.existsSync(path.join(cwd, 'node_modules')),
    installDependencies: ({ cwd }) => {
      const result = runProcess({
        args: ['install', '--frozen-lockfile'],
        captureOutput: false,
        command: 'pnpm',
        cwd,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to install dependencies in ${cwd}`);
      }
    },
    notify: ({ body, enabled, title }) => {
      if (!enabled) {
        return;
      }
      runProcess({
        args: ['notify', '--title', title, '--body', body],
        command: 'cmux',
        cwd: process.cwd(),
      });
    },
    pushBranch: ({ cwd }) => {
      const result = runProcess({
        args: ['push', '-u', 'origin', 'HEAD'],
        captureOutput: false,
        command: 'git',
        cwd,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to push branch from ${cwd}`);
      }
    },
    sendCodexInput: ({ cwd, jobId, prompt }) => {
      const result = runProcess({
        args: ['send', jobId, prompt],
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      });
      if (result.exitCode !== 0) {
        throw new Error(result.output);
      }
    },
    startCodexJob: ({ cwd, model, notifyOnComplete, prompt, reasoning, sandbox }) => {
      const args = [
        'start',
        prompt,
        '--map',
        '-s',
        sandbox,
        '-d',
        cwd,
        '-m',
        model,
        '-r',
        reasoning,
      ];
      if (notifyOnComplete) {
        args.push('--notify-on-complete', 'cmux notify --title "Codex" --body "Agent ready"');
      }

      const result = runProcess({
        args,
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      });
      if (result.exitCode !== 0) {
        throw new Error(result.output);
      }
      return result.output;
    },
    syncEnvFiles: ({ repoRoot, worktreePath }) => {
      const envFiles: string[] = [];
      collectEnvFiles({ currentDir: repoRoot, foundFiles: envFiles });

      for (const envFile of envFiles) {
        const relativePath = path.relative(repoRoot, envFile);
        const destination = path.join(worktreePath, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(envFile, destination);
      }
    },
    watchCi: ({ cwd }) => {
      const result = runProcess({
        args: ['run', 'watch'],
        command: 'gh',
        cwd,
      });
      return {
        output: result.output,
        success: result.exitCode === 0,
      };
    },
  };
}
