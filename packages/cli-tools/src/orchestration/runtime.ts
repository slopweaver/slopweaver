import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { err, ok, type Result } from '@slopweaver/errors';
import { BLUE, GREEN, NC, YELLOW } from '../lib/colors.ts';
import type { MonorepoRootNotFoundError } from '../lib/errors.ts';
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
import {
  type OrchestrationError,
  OrchestrationErrors,
  type OrchestrationModelAttemptError,
  type OrchestrationSubprocessFailedError,
} from './errors.ts';

interface RunOrchestrationOptions {
  chainInputPath: string;
  dryRun: boolean;
  executor: ExecutorMode;
  notify: boolean;
  restart: boolean;
}

interface PrepareOrchestrationOptions {
  chainInputPath: string;
  executor: ExecutorMode;
  restart: boolean;
}

interface LauncherManifest {
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

interface RunState {
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

interface RunOrchestrationEnvironment {
  awaitCodexTurn(args: {
    cwd: string;
    jobId: string;
  }): Result<string, OrchestrationSubprocessFailedError>;
  closeCodexJob(args: { cwd: string; jobId: string }): void;
  commitAll(args: {
    cwd: string;
    ignoredPaths: string[];
    message: string;
  }): Result<boolean, OrchestrationSubprocessFailedError>;
  createOrReusePr(args: {
    body: string;
    cwd: string;
    title: string;
  }): Result<string, OrchestrationError>;
  ensureWorktree(args: {
    repoRoot: string;
    worktreeName: string;
  }): Result<string, OrchestrationSubprocessFailedError>;
  getBranchName(args: { cwd: string }): Result<string, OrchestrationSubprocessFailedError>;
  getLatestCiRunId(args: { branchName: string; cwd: string }): string | null;
  getWorktreeStatus(args: { cwd: string }): string[];
  hasDependencies(args: { cwd: string }): boolean;
  installDependencies(args: { cwd: string }): Result<void, OrchestrationSubprocessFailedError>;
  notify(args: { body: string; enabled: boolean; title: string }): void;
  pushBranch(args: { cwd: string }): Result<void, OrchestrationSubprocessFailedError>;
  sendCodexInput(args: {
    cwd: string;
    jobId: string;
    prompt: string;
  }): Result<void, OrchestrationSubprocessFailedError>;
  startCodexJob(args: {
    cwd: string;
    model: string;
    notifyOnComplete: boolean;
    prompt: string;
    reasoning: ModelSelection['reasoning'];
    sandbox: 'read-only' | 'workspace-write';
  }): Result<string, OrchestrationSubprocessFailedError>;
  syncEnvFiles(args: { repoRoot: string; worktreePath: string }): void;
  watchCi(args: { cwd: string }): { output: string; success: boolean };
}

const STATE_FILENAME = 'state.json';
const FINAL_PLAN_FILENAME = 'final-plan.md';
const HYBRID_INITIAL_PLAN_PROMPT_FILENAME = 'hybrid-plan-initial.prompt.md';
const HYBRID_REVIEW_PROMPT_FILENAME = 'hybrid-review.prompt.md';
const HYBRID_SEND_PROMPT_PREFIX = 'hybrid-plan-send';
const MAX_REVIEW_ATTEMPTS = 5;
const MAX_CI_ATTEMPTS = 5;

const PHASE_ORDER: OrchestrationPhase[] = [
  'initial',
  'planning',
  'implementation',
  'pr',
  'review',
  'ci',
  'awaiting_manual_qa',
];

function phaseIndex(phase: OrchestrationPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

// Phase functions only ever move state.phase forward — never regress it on
// resume. Without this, calling runPlanningPhase (idempotent via cache) on a
// resumed run that was already in 'ci' would rewind state.phase to 'planning'.
function advancePhase({ state, target }: { state: RunState; target: OrchestrationPhase }): void {
  if (phaseIndex(state.phase) < phaseIndex(target)) {
    state.phase = target;
  }
}

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

function checkWorktreeIsReady({
  env,
  state,
}: {
  env: RunOrchestrationEnvironment;
  state: RunState;
}): Result<void, OrchestrationError> {
  const relevantStatus = getRelevantWorktreeStatus({ env, state });
  const hasMergeConflicts = relevantStatus.some(
    (line) => line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('DD '),
  );
  if (hasMergeConflicts) {
    return err(OrchestrationErrors.worktreeMergeConflict(state.worktreePath));
  }

  if (relevantStatus.length > 0) {
    return err(OrchestrationErrors.worktreeDirty(state.worktreePath));
  }

  return ok(undefined);
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
}): Result<void, OrchestrationError> {
  const worktreeResult = env.ensureWorktree({ repoRoot, worktreeName });
  if (worktreeResult.isErr()) return err(worktreeResult.error);
  state.worktreePath = worktreeResult.value;
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
    const installResult = env.installDependencies({ cwd: state.worktreePath });
    if (installResult.isErr()) return err(installResult.error);
  }

  const branchResult = env.getBranchName({ cwd: state.worktreePath });
  if (branchResult.isErr()) return err(branchResult.error);
  state.branchName = branchResult.value;

  return checkWorktreeIsReady({ env, state });
}

/**
 * One attempt at a codex job. The catch-IS-the-classifier pattern from the
 * pre-Result implementation is preserved structurally: every subprocess
 * failure inside the attempt is classified via `looksLikeTransientModelFailure`
 * and surfaced as `ORCHESTRATION_MODEL_ATTEMPT { kind: 'transient' | 'fatal' }`.
 * Job-id parse failures count as fatal — a malformed codex-agent CLI output
 * isn't going to recover by re-running the same prompt.
 *
 * The `finally { closeCodexJob }` cleanup matches the original imperative
 * shape; keeping it imperative is simpler than threading it through `.map`.
 */
function runOneModelAttempt({
  candidate,
  cwd,
  env,
  notifyOnComplete,
  prompt,
  sandbox,
}: {
  candidate: ModelSelection;
  cwd: string;
  env: RunOrchestrationEnvironment;
  notifyOnComplete: boolean;
  prompt: string;
  sandbox: 'read-only' | 'workspace-write';
}): Result<string, OrchestrationModelAttemptError> {
  let jobId: string | null = null;

  try {
    const startResult = env.startCodexJob({
      cwd,
      model: candidate.model,
      notifyOnComplete,
      prompt,
      reasoning: candidate.reasoning,
      sandbox,
    });
    if (startResult.isErr()) {
      const lastError = startResult.error.message;
      return err(
        OrchestrationErrors.modelAttempt({
          kind: looksLikeTransientModelFailure({ output: lastError }) ? 'transient' : 'fatal',
          lastError,
        }),
      );
    }

    const jobIdResult = parseCodexJobId({ output: startResult.value });
    if (jobIdResult.isErr()) {
      return err(
        OrchestrationErrors.modelAttempt({ kind: 'fatal', lastError: jobIdResult.error.message }),
      );
    }
    jobId = jobIdResult.value;

    const awaitResult = env.awaitCodexTurn({ cwd, jobId });
    env.closeCodexJob({ cwd, jobId });
    jobId = null;
    if (awaitResult.isErr()) {
      const lastError = awaitResult.error.message;
      return err(
        OrchestrationErrors.modelAttempt({
          kind: looksLikeTransientModelFailure({ output: lastError }) ? 'transient' : 'fatal',
          lastError,
        }),
      );
    }

    const output = awaitResult.value;
    if (looksLikeTransientModelFailure({ output })) {
      return err(OrchestrationErrors.modelAttempt({ kind: 'transient', lastError: output }));
    }

    return ok(output);
  } finally {
    if (jobId !== null) {
      env.closeCodexJob({ cwd, jobId });
    }
  }
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
}): Result<string, OrchestrationError> {
  const attemptCount = bumpRetryCount({ key: retryKey, state }) - 1;
  const candidates = getModelCandidates({ attempts: attemptCount, kind });
  let lastError = '';

  for (const candidate of candidates) {
    const attempt = runOneModelAttempt({
      candidate,
      cwd,
      env,
      notifyOnComplete,
      prompt,
      sandbox,
    });

    if (attempt.isOk()) {
      writeArtifact({
        filename: `${retryKey}-${candidate.model}.md`,
        runDirectory,
        value: attempt.value,
      });
      return ok(attempt.value);
    }

    lastError = attempt.error.lastError;
    if (attempt.error.kind === 'fatal') {
      return err(attempt.error);
    }
    // transient → try next candidate
  }

  return err(OrchestrationErrors.allModelsFailed({ retryKey, lastError }));
}

/**
 * The planning conversation has the same retry-loop structure as
 * runCodexPromptWithFallback but with an additional follow-up loop: after
 * the initial plan, each `codex-send` step issues another prompt into the
 * same job. Every follow-up step is also classified by transient/fatal.
 */
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
}): Result<{ finalPlan: string; initialPlan: string }, OrchestrationError> {
  const planStep = chain.steps.find((step) => step.role === 'codex-plan');
  if (!planStep?.promptTemplate) {
    return err(OrchestrationErrors.missingPlanPrompt(chain.chainPath));
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
    const attemptResult = runOnePlanningAttempt({
      candidate,
      chain,
      env,
      initialPrompt,
      runDirectory,
      sendSteps,
      state,
    });

    if (attemptResult.isOk()) {
      return ok(attemptResult.value);
    }

    lastError = attemptResult.error.lastError;
    if (attemptResult.error.kind === 'fatal') {
      return err(attemptResult.error);
    }
    // transient → try next candidate
  }

  return err(OrchestrationErrors.allModelsFailed({ retryKey: 'planner-main', lastError }));
}

function runOnePlanningAttempt({
  candidate,
  chain,
  env,
  initialPrompt,
  runDirectory,
  sendSteps,
  state,
}: {
  candidate: ModelSelection;
  chain: ParsedChain;
  env: RunOrchestrationEnvironment;
  initialPrompt: string;
  runDirectory: string;
  sendSteps: ParsedChain['steps'];
  state: RunState;
}): Result<{ finalPlan: string; initialPlan: string }, OrchestrationModelAttemptError> {
  let jobId: string | null = null;

  try {
    const startResult = env.startCodexJob({
      cwd: state.worktreePath,
      model: candidate.model,
      notifyOnComplete: false,
      prompt: initialPrompt,
      reasoning: candidate.reasoning,
      sandbox: 'read-only',
    });
    if (startResult.isErr()) {
      const lastError = startResult.error.message;
      return err(
        OrchestrationErrors.modelAttempt({
          kind: looksLikeTransientModelFailure({ output: lastError }) ? 'transient' : 'fatal',
          lastError,
        }),
      );
    }

    const jobIdResult = parseCodexJobId({ output: startResult.value });
    if (jobIdResult.isErr()) {
      return err(
        OrchestrationErrors.modelAttempt({ kind: 'fatal', lastError: jobIdResult.error.message }),
      );
    }
    jobId = jobIdResult.value;

    const initialPlanResult = env.awaitCodexTurn({ cwd: state.worktreePath, jobId });
    if (initialPlanResult.isErr()) {
      const lastError = initialPlanResult.error.message;
      return err(
        OrchestrationErrors.modelAttempt({
          kind: looksLikeTransientModelFailure({ output: lastError }) ? 'transient' : 'fatal',
          lastError,
        }),
      );
    }
    const initialPlan = initialPlanResult.value;
    if (looksLikeTransientModelFailure({ output: initialPlan })) {
      return err(OrchestrationErrors.modelAttempt({ kind: 'transient', lastError: initialPlan }));
    }

    writeArtifact({
      filename: `planner-main-step-0-${candidate.model}.md`,
      runDirectory,
      value: initialPlan,
    });

    let finalPlan = initialPlan;
    const activeJobId = jobId;
    for (let index = 0; index < sendSteps.length; index += 1) {
      const step = sendSteps[index];
      if (!step) continue;
      const prompt = interpolateTemplate({
        template: step.promptTemplate ?? '',
        variables: chain.variables,
      });

      const sendResult = env.sendCodexInput({
        cwd: state.worktreePath,
        jobId: activeJobId,
        prompt,
      });
      if (sendResult.isErr()) {
        const lastError = sendResult.error.message;
        return err(
          OrchestrationErrors.modelAttempt({
            kind: looksLikeTransientModelFailure({ output: lastError }) ? 'transient' : 'fatal',
            lastError,
          }),
        );
      }

      const awaitResult = env.awaitCodexTurn({ cwd: state.worktreePath, jobId: activeJobId });
      if (awaitResult.isErr()) {
        const lastError = awaitResult.error.message;
        return err(
          OrchestrationErrors.modelAttempt({
            kind: looksLikeTransientModelFailure({ output: lastError }) ? 'transient' : 'fatal',
            lastError,
          }),
        );
      }
      finalPlan = awaitResult.value;

      if (looksLikeTransientModelFailure({ output: finalPlan })) {
        return err(OrchestrationErrors.modelAttempt({ kind: 'transient', lastError: finalPlan }));
      }

      writeArtifact({
        filename: `planner-main-step-${index + 1}-${candidate.model}.md`,
        runDirectory,
        value: finalPlan,
      });
    }

    env.closeCodexJob({ cwd: state.worktreePath, jobId });
    jobId = null;
    return ok({ finalPlan, initialPlan });
  } finally {
    if (jobId !== null) {
      env.closeCodexJob({ cwd: state.worktreePath, jobId });
    }
  }
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
}): Result<string, OrchestrationError> {
  advancePhase({ state, target: 'planning' });
  const cachedPlan = readArtifact({ filename: FINAL_PLAN_FILENAME, runDirectory });
  if (cachedPlan) {
    return ok(cachedPlan);
  }

  const planningResult = runPlanningConversationWithFallback({ chain, env, runDirectory, state });
  if (planningResult.isErr()) return err(planningResult.error);

  writeArtifact({
    filename: FINAL_PLAN_FILENAME,
    runDirectory,
    value: planningResult.value.finalPlan,
  });
  state.plannerOutputs['planner-main'] = planningResult.value.initialPlan;
  return ok(planningResult.value.finalPlan);
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
}): Result<void, OrchestrationError> {
  advancePhase({ state, target: 'implementation' });

  for (const slice of profile.implementationSlices) {
    if (state.completedSlices.includes(slice.id)) {
      continue;
    }

    const outputResult = runCodexPromptWithFallback({
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
    if (outputResult.isErr()) return err(outputResult.error);

    const output = outputResult.value;
    state.implementationOutputs[slice.id] = output;
    writeArtifact({ filename: `${slice.id}.md`, runDirectory, value: output });

    const commitResult = env.commitAll({
      cwd: state.worktreePath,
      ignoredPaths: state.ignoredWorktreeRelativePaths,
      message: slice.commitMessage,
    });
    if (commitResult.isErr()) return err(commitResult.error);

    state.completedSlices.push(slice.id);
  }

  return ok(undefined);
}

function ensurePr({
  chain,
  env,
  state,
}: {
  chain: ParsedChain;
  env: RunOrchestrationEnvironment;
  state: RunState;
}): Result<string, OrchestrationError> {
  advancePhase({ state, target: 'pr' });
  if (state.prUrl) {
    return ok(state.prUrl);
  }

  const pushResult = env.pushBranch({ cwd: state.worktreePath });
  if (pushResult.isErr()) return err(pushResult.error);

  const prResult = env.createOrReusePr({
    body: buildPrBody({
      chainPath: chain.chainPath,
      chainTitle: chain.title,
      executor: state.executor,
    }),
    cwd: state.worktreePath,
    title: chain.title,
  });
  if (prResult.isErr()) return err(prResult.error);

  state.prUrl = prResult.value;
  return ok(prResult.value);
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
}): Result<void, OrchestrationError> {
  advancePhase({ state, target: 'review' });
  const reviewStep = chain.steps.find((step) => step.role === 'codex-review');
  if (!reviewStep?.promptTemplate || !state.prUrl) {
    return ok(undefined);
  }

  // Early-exit when resuming a run whose last review already passed — avoids
  // re-spawning a review agent against an already-clean PR after a crash
  // between review-success and ci-start.
  if (state.lastReviewOutput && isSuccessfulReview({ reviewOutput: state.lastReviewOutput })) {
    return ok(undefined);
  }

  for (;;) {
    if (state.reviewAttempts >= MAX_REVIEW_ATTEMPTS) {
      return err(
        OrchestrationErrors.reviewNotConverged({
          attempts: state.reviewAttempts,
          runDirectory,
        }),
      );
    }

    const reviewResult = runCodexPromptWithFallback({
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
    if (reviewResult.isErr()) return err(reviewResult.error);
    const reviewOutput = reviewResult.value;

    state.reviewAttempts += 1;
    state.reviewOutputs.push(reviewOutput);
    state.lastReviewOutput = reviewOutput;
    writeArtifact({
      filename: `review-${state.reviewAttempts}.md`,
      runDirectory,
      value: reviewOutput,
    });

    if (isSuccessfulReview({ reviewOutput })) {
      return ok(undefined);
    }

    const fixResult = runCodexPromptWithFallback({
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
    if (fixResult.isErr()) return err(fixResult.error);
    const fixOutput = fixResult.value;

    writeArtifact({
      filename: `review-fix-${state.reviewAttempts}.md`,
      runDirectory,
      value: fixOutput,
    });

    const commitResult = env.commitAll({
      cwd: state.worktreePath,
      ignoredPaths: state.ignoredWorktreeRelativePaths,
      message: `fix: address codex review findings ${state.reviewAttempts}`,
    });
    if (commitResult.isErr()) return err(commitResult.error);

    const pushResult = env.pushBranch({ cwd: state.worktreePath });
    if (pushResult.isErr()) return err(pushResult.error);
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
}): Result<void, OrchestrationError> {
  advancePhase({ state, target: 'ci' });

  for (;;) {
    if (state.ciAttempts >= MAX_CI_ATTEMPTS) {
      return err(
        OrchestrationErrors.ciNotConverged({
          attempts: state.ciAttempts,
          runDirectory,
        }),
      );
    }

    const ciResult = env.watchCi({ cwd: state.worktreePath });
    state.ciAttempts += 1;
    writeArtifact({
      filename: `ci-watch-${state.ciAttempts}.md`,
      runDirectory,
      value: ciResult.output,
    });

    if (ciResult.success) {
      return ok(undefined);
    }

    const latestRunId =
      state.branchName === null
        ? null
        : env.getLatestCiRunId({ branchName: state.branchName, cwd: state.worktreePath });
    if (latestRunId === null) {
      return err(OrchestrationErrors.ciRunIdMissing());
    }

    const diagnosisResult = runCodexPromptWithFallback({
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
    if (diagnosisResult.isErr()) return err(diagnosisResult.error);
    const diagnosisOutput = diagnosisResult.value;

    writeArtifact({
      filename: `ci-diagnosis-${state.ciAttempts}.md`,
      runDirectory,
      value: diagnosisOutput,
    });

    const fixResult = runCodexPromptWithFallback({
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
    if (fixResult.isErr()) return err(fixResult.error);
    const fixOutput = fixResult.value;

    writeArtifact({ filename: `ci-fix-${state.ciAttempts}.md`, runDirectory, value: fixOutput });

    const commitResult = env.commitAll({
      cwd: state.worktreePath,
      ignoredPaths: state.ignoredWorktreeRelativePaths,
      message: `fix: address ci failures ${state.ciAttempts}`,
    });
    if (commitResult.isErr()) return err(commitResult.error);

    const pushResult = env.pushBranch({ cwd: state.worktreePath });
    if (pushResult.isErr()) return err(pushResult.error);
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

function resolveChainContext({ chainInputPath }: { chainInputPath: string }): Result<
  {
    chain: ParsedChain;
    profile: ChainProfile;
    repoRoot: string;
    runDirectory: string;
    runSlug: string;
    stateFilePath: string;
    worktreePath: string;
    worktreeName: string;
  },
  OrchestrationError | MonorepoRootNotFoundError
> {
  const repoRootResult = findMonorepoRoot();
  if (repoRootResult.isErr()) return err(repoRootResult.error);
  const repoRoot = repoRootResult.value;
  const worktreesRoot = resolveWorktreesRoot({ repoRoot });
  const chainPath = resolveChainPath({ inputPath: chainInputPath, repoRoot });
  const markdown = fs.readFileSync(chainPath, 'utf8');
  const chainResult = parseOrchestrationChain({ chainPath, markdown });
  if (chainResult.isErr()) return err(chainResult.error);
  const chain = chainResult.value;
  const profile = getProfile({ profileId: resolveProfileId() });
  const worktreeName = resolveWorktreeName({ chain });
  const worktreePath = path.join(worktreesRoot, worktreeName);
  const runSlug = resolveRunSlug({ chainPath, repoRoot });
  const runDirectory = getRunDirectory({ runSlug });

  return ok({
    chain,
    profile,
    repoRoot,
    runDirectory,
    runSlug,
    stateFilePath: getStateFilePath({ runDirectory }),
    worktreeName,
    worktreePath,
  });
}

export async function prepareOrchestration({
  env = createDefaultEnvironment(),
  options,
}: {
  env?: RunOrchestrationEnvironment | undefined;
  options: PrepareOrchestrationOptions;
}): Promise<Result<void, OrchestrationError | MonorepoRootNotFoundError>> {
  const contextResult = resolveChainContext({ chainInputPath: options.chainInputPath });
  if (contextResult.isErr()) return err(contextResult.error);
  const { chain, runDirectory, stateFilePath, runSlug, worktreePath, worktreeName, repoRoot } =
    contextResult.value;

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
  const bootstrapResult = bootstrapRunState({ env, repoRoot, state, worktreeName });
  if (bootstrapResult.isErr()) return err(bootstrapResult.error);
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

  return ok(undefined);
}

export async function runOrchestration({
  env = createDefaultEnvironment(),
  options,
}: {
  env?: RunOrchestrationEnvironment | undefined;
  options: RunOrchestrationOptions;
}): Promise<Result<void, OrchestrationError | MonorepoRootNotFoundError>> {
  const executor = options.executor;
  const contextResult = resolveChainContext({ chainInputPath: options.chainInputPath });
  if (contextResult.isErr()) return err(contextResult.error);
  const {
    chain,
    profile,
    repoRoot,
    runDirectory,
    stateFilePath,
    runSlug,
    worktreePath,
    worktreeName,
  } = contextResult.value;

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
    return ok(undefined);
  }

  ensureRunDirectories({ runDirectory });
  state.executor = executor;
  const bootstrapResult = bootstrapRunState({ env, repoRoot, state, worktreeName });
  if (bootstrapResult.isErr()) return err(bootstrapResult.error);
  saveState({ runDirectory, state });
  logResumeState({ hasExistingState, state });

  if (state.phase === 'awaiting_manual_qa') {
    console.log(
      `${YELLOW}Run already paused at manual QA:${NC} ${GREEN}${state.prUrl ?? '(no PR URL)'}${NC}`,
    );
    console.log(buildStateSummary({ state }));
    return ok(undefined);
  }

  // Planning is always called: it returns the cached plan when present and
  // advancePhase() prevents it from regressing state.phase on a resumed run.
  const planResult = runPlanningPhase({ chain, env, runDirectory, state });
  if (planResult.isErr()) return err(planResult.error);
  const finalPlan = planResult.value;
  saveState({ runDirectory, state });

  // Skip phases that have already completed on a previous run. The phase
  // functions are also idempotent (implementation skips completedSlices,
  // ensurePr early-returns when prUrl is set, runReviewPhase early-exits when
  // lastReviewOutput already passed), but gating here also avoids the
  // overhead of re-entering them.
  if (phaseIndex(state.phase) <= phaseIndex('implementation')) {
    const implResult = runImplementationPhase({ env, finalPlan, profile, runDirectory, state });
    if (implResult.isErr()) return err(implResult.error);
    saveState({ runDirectory, state });
  }

  if (phaseIndex(state.phase) <= phaseIndex('pr')) {
    const prResult = ensurePr({ chain, env, state });
    if (prResult.isErr()) return err(prResult.error);
    saveState({ runDirectory, state });
  }

  if (phaseIndex(state.phase) <= phaseIndex('review')) {
    const reviewResult = runReviewPhase({ chain, env, finalPlan, runDirectory, state });
    if (reviewResult.isErr()) return err(reviewResult.error);
    saveState({ runDirectory, state });
  }

  if (phaseIndex(state.phase) <= phaseIndex('ci')) {
    const ciResult = runCiPhase({ env, finalPlan, runDirectory, state });
    if (ciResult.isErr()) return err(ciResult.error);
  }

  advancePhase({ state, target: 'awaiting_manual_qa' });
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

  return ok(undefined);
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

function runProcessAsResult({
  args,
  captureOutput,
  command,
  cwd,
  env,
}: {
  args: string[];
  captureOutput?: boolean;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Result<string, OrchestrationSubprocessFailedError> {
  const opts: Parameters<typeof runProcess>[0] = { args, command, cwd };
  if (captureOutput !== undefined) opts.captureOutput = captureOutput;
  if (env !== undefined) opts.env = env;
  const result = runProcess(opts);
  if (result.exitCode !== 0) {
    return err(
      OrchestrationErrors.subprocessFailed({
        command,
        args,
        cwd,
        exitCode: result.exitCode,
        output: result.output,
      }),
    );
  }
  return ok(result.output);
}

function createDefaultEnvironment(): RunOrchestrationEnvironment {
  return {
    awaitCodexTurn: ({ cwd, jobId }) =>
      runProcessAsResult({
        args: ['await-turn', jobId],
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      }),
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
        return ok(false);
      }

      const addArgs = ['add', '-A', '--', '.'];
      ignoredPaths.forEach((ignoredPath) => {
        addArgs.push(`:(exclude)${ignoredPath}`);
      });

      const addResult = runProcessAsResult({
        args: addArgs,
        captureOutput: false,
        command: 'git',
        cwd,
      });
      if (addResult.isErr()) return err(addResult.error);

      const commitResult = runProcessAsResult({
        args: ['commit', '-m', message],
        captureOutput: false,
        command: 'git',
        cwd,
      });
      if (commitResult.isErr()) return err(commitResult.error);

      return ok(true);
    },
    createOrReusePr: ({ body, cwd, title }) => {
      const existingPr = runProcess({
        args: ['pr', 'view', '--json', 'url', '--jq', '.url'],
        command: 'gh',
        cwd,
      });
      if (existingPr.exitCode === 0 && existingPr.output.trim()) {
        return ok(existingPr.output.trim());
      }

      const createdResult = runProcessAsResult({
        args: ['pr', 'create', '--title', title, '--body', body],
        command: 'gh',
        cwd,
      });
      if (createdResult.isErr()) return err(createdResult.error);

      const prUrlResult = parsePullRequestUrl({ output: createdResult.value });
      if (prUrlResult.isErr()) return err(prUrlResult.error);
      return ok(prUrlResult.value);
    },
    ensureWorktree: ({ repoRoot, worktreeName }) => {
      const worktreePath = path.join(resolveWorktreesRoot({ repoRoot }), worktreeName);
      if (fs.existsSync(worktreePath)) {
        return ok(worktreePath);
      }

      const result = runProcessAsResult({
        args: ['cli', 'worktree-new', worktreeName],
        captureOutput: false,
        command: 'pnpm',
        cwd: repoRoot,
      });
      if (result.isErr()) return err(result.error);
      return ok(worktreePath);
    },
    getBranchName: ({ cwd }) => {
      const result = runProcessAsResult({
        args: ['branch', '--show-current'],
        command: 'git',
        cwd,
      });
      if (result.isErr()) return err(result.error);
      return ok(result.value.trim());
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
      const result = runProcessAsResult({
        args: ['install', '--frozen-lockfile'],
        captureOutput: false,
        command: 'pnpm',
        cwd,
      });
      if (result.isErr()) return err(result.error);
      return ok(undefined);
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
      const result = runProcessAsResult({
        args: ['push', '-u', 'origin', 'HEAD'],
        captureOutput: false,
        command: 'git',
        cwd,
      });
      if (result.isErr()) return err(result.error);
      return ok(undefined);
    },
    sendCodexInput: ({ cwd, jobId, prompt }) => {
      const result = runProcessAsResult({
        args: ['send', jobId, prompt],
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      });
      if (result.isErr()) return err(result.error);
      return ok(undefined);
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

      return runProcessAsResult({
        args,
        command: 'codex-agent',
        cwd,
        env: getAugmentedPathEnv(),
      });
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
