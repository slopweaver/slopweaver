import path from 'node:path';

export const ORCHESTRATION_ROLES = [
  'codex-plan',
  'codex-send',
  'claude-implement',
  'codex-review',
] as const;

export type OrchestrationRole = (typeof ORCHESTRATION_ROLES)[number];
export type ExecutorMode = 'codex-only' | 'hybrid';
export type OrchestrationPhase =
  | 'initial'
  | 'planning'
  | 'implementation'
  | 'pr'
  | 'review'
  | 'ci'
  | 'awaiting_manual_qa';
export type ProfileId = 'generic';
export type ModelTaskKind = 'planning' | 'implementation' | 'review' | 'diagnosis';
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';

export interface ParsedChainStep {
  body: string;
  headingLevel: number;
  index: number;
  promptTemplate: string | null;
  role: OrchestrationRole | null;
  title: string;
}

export interface ParsedChain {
  chainPath: string;
  steps: ParsedChainStep[];
  title: string;
  variables: Record<string, string>;
}

export interface PlannerDefinition {
  focus: string;
  id: string;
  label: string;
}

export interface ImplementationSliceDefinition {
  commitMessage: string;
  focus: string;
  id: string;
  label: string;
}

export interface ChainProfile {
  id: ProfileId;
  implementationSlices: ImplementationSliceDefinition[];
  label: string;
  planners: PlannerDefinition[];
}

export interface ModelSelection {
  model: string;
  reasoning: ReasoningLevel;
}

export interface RuntimePlan {
  executor: ExecutorMode;
  phases: string[];
  profile: ChainProfile;
  worktreeName: string;
}

const STEP_HEADING_REGEX =
  /^(#{2,4})\s+Step\s+(\d+):\s+(.+?)(?:\s+\((codex-plan|codex-send|claude-implement|codex-review)\))?\s*$/;
const VARIABLE_REGEX = /^- `\{([^}]+)\}`:\s*(.+)$/;

function normalizeVariableValue({ rawValue }: { rawValue: string }): string {
  const trimmedValue = rawValue.trim();
  const inlineCodeMatch = trimmedValue.match(/^`([^`]+)`$/);
  if (inlineCodeMatch?.[1]) {
    return inlineCodeMatch[1];
  }

  return trimmedValue;
}

const PROFILE_REGISTRY: Record<ProfileId, ChainProfile> = {
  generic: {
    id: 'generic',
    implementationSlices: [
      {
        commitMessage: 'feat: implement orchestration chain',
        focus:
          'Implement the full chain in one pass while preserving the chain instructions exactly.',
        id: 'worker-main',
        label: 'Worker',
      },
    ],
    label: 'Shared Orchestration',
    planners: [
      {
        focus:
          'Produce the full plan required by the chain. Cover all requested files, risks, and tests.',
        id: 'planner-main',
        label: 'Planner',
      },
    ],
  },
};

export function resolveChainPath({
  inputPath,
  repoRoot,
}: {
  inputPath: string;
  repoRoot: string;
}): string {
  const withoutAt = inputPath.startsWith('@') ? inputPath.slice(1) : inputPath;
  if (path.isAbsolute(withoutAt)) {
    return path.normalize(withoutAt);
  }

  return path.normalize(path.resolve(repoRoot, withoutAt));
}

export function resolveChainRelativePath({
  chainPath,
  repoRoot,
}: {
  chainPath: string;
  repoRoot: string;
}): string | null {
  const relativePath = path.relative(repoRoot, chainPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return path.normalize(relativePath);
}

export function sanitizeSlug({ value }: { value: string }): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function resolveRunSlug({
  chainPath,
  repoRoot,
}: {
  chainPath: string;
  repoRoot: string;
}): string {
  const relativePath = resolveChainRelativePath({ chainPath, repoRoot }) ?? chainPath;
  const extension = path.extname(relativePath);
  const withoutExtension =
    extension.length > 0 ? relativePath.slice(0, -extension.length) : relativePath;
  const slugSource = withoutExtension.replace(/[\\/]+/g, '--');
  return sanitizeSlug({ value: slugSource });
}

export function parseOrchestrationChain({
  chainPath,
  markdown,
}: {
  chainPath: string;
  markdown: string;
}): ParsedChain {
  const lines = markdown.split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith('# '));
  if (!titleLine) {
    throw new Error(`Missing top-level title in orchestration chain: ${chainPath}`);
  }

  const steps: ParsedChainStep[] = [];
  let currentStepStart = -1;
  let currentStepMeta: {
    headingLevel: number;
    index: number;
    role: OrchestrationRole | null;
    title: string;
  } | null = null;
  let inVariablesSection = false;
  const variables: Record<string, string> = {};

  const finalizeStep = ({ endExclusive }: { endExclusive: number }): void => {
    if (!currentStepMeta) {
      return;
    }

    const body = lines
      .slice(currentStepStart + 1, endExclusive)
      .join('\n')
      .trim();
    const promptMatch = body.match(/```prompt\n([\s\S]*?)```/m);

    steps.push({
      body,
      headingLevel: currentStepMeta.headingLevel,
      index: currentStepMeta.index,
      promptTemplate: promptMatch?.[1]?.trim() ?? null,
      role: currentStepMeta.role,
      title: currentStepMeta.title,
    });
  };

  lines.forEach((line, lineIndex) => {
    const headingMatch = line.match(STEP_HEADING_REGEX);
    if (headingMatch) {
      finalizeStep({ endExclusive: lineIndex });
      currentStepStart = lineIndex;
      currentStepMeta = {
        headingLevel: headingMatch[1]?.length ?? 2,
        index: Number(headingMatch[2]),
        role: (headingMatch[4] as OrchestrationRole | undefined) ?? null,
        title: headingMatch[3]?.trim() ?? `Step ${headingMatch[2]}`,
      };
      inVariablesSection = false;
      return;
    }

    if (line.startsWith('## ')) {
      inVariablesSection = line.trim() === '## Variables';
      return;
    }

    if (!inVariablesSection) {
      return;
    }

    const variableMatch = line.match(VARIABLE_REGEX);
    if (!variableMatch) {
      return;
    }

    const [, key, rawValue] = variableMatch;
    if (key && rawValue) {
      variables[key] = normalizeVariableValue({ rawValue });
    }
  });

  finalizeStep({ endExclusive: lines.length });

  return {
    chainPath,
    steps,
    title: titleLine.replace(/^#\s+/, '').trim(),
    variables,
  };
}

export function interpolateTemplate({
  template,
  variables,
}: {
  template: string;
  variables: Record<string, string>;
}): string {
  return template.replace(/\{([^}]+)\}/g, (match, key) => variables[key] ?? match);
}

export function resolveProfileId(): ProfileId {
  return 'generic';
}

export function getProfile({ profileId }: { profileId: ProfileId }): ChainProfile {
  return PROFILE_REGISTRY[profileId];
}

export function resolveWorktreeName({ chain }: { chain: ParsedChain }): string {
  const configured = chain.variables['worktree'];
  if (configured) {
    const basename = configured.replace(/\\/g, '/').split('/').pop() ?? configured;
    const sanitized = sanitizeSlug({ value: basename.replace(/[{}]/g, '') });
    if (sanitized) {
      return sanitized;
    }
  }

  const fallback = path.basename(chain.chainPath, path.extname(chain.chainPath));
  return sanitizeSlug({ value: fallback });
}

export function buildRuntimePlan({
  chain,
  executor,
  profile,
}: {
  chain: ParsedChain;
  executor: ExecutorMode;
  profile: ChainProfile;
}): RuntimePlan {
  const worktreeName = resolveWorktreeName({ chain });
  const phases =
    executor === 'hybrid'
      ? [
          `worktree bootstrap: ${worktreeName}`,
          'codex planning',
          'claude implementation',
          'pr creation',
          'codex review loop',
          'ci loop',
          'stop at human review and manual qa',
        ]
      : [
          `worktree bootstrap: ${worktreeName}`,
          'codex planning',
          'codex implementation',
          'pr creation',
          'codex review loop',
          'ci loop',
          'stop at human review and manual qa',
        ];

  return { executor, phases, profile, worktreeName };
}

export function formatDryRunPlan({
  chain,
  executor,
  profile,
}: {
  chain: ParsedChain;
  executor: ExecutorMode;
  profile: ChainProfile;
}): string {
  const runtimePlan = buildRuntimePlan({ chain, executor, profile });
  return [
    `Chain: ${chain.title}`,
    `Executor: ${executor}`,
    `Profile: ${profile.id}`,
    'Phases:',
    ...runtimePlan.phases.map((phase, index) => `${index + 1}. ${phase}`),
  ].join('\n');
}

export function findFirstStepByRole({
  chain,
  role,
}: {
  chain: ParsedChain;
  role: OrchestrationRole;
}): ParsedChainStep | null {
  return chain.steps.find((step) => step.role === role) ?? null;
}

export function findStepsByRole({
  chain,
  role,
}: {
  chain: ParsedChain;
  role: OrchestrationRole;
}): ParsedChainStep[] {
  return chain.steps.filter((step) => step.role === role);
}

export function buildPlannerPrompt({
  planner,
  stepPrompt,
}: {
  planner: PlannerDefinition;
  stepPrompt: string;
}): string {
  return [
    stepPrompt.trim(),
    '',
    `Focus slice: ${planner.label}.`,
    planner.focus,
    'Do not drift outside this focus area.',
  ].join('\n');
}

export function buildImplementationPrompt({
  executor,
  finalPlan,
  profile,
  slice,
}: {
  executor: ExecutorMode;
  finalPlan: string;
  profile: ChainProfile;
  slice: ImplementationSliceDefinition;
}): string {
  const preamble =
    executor === 'hybrid'
      ? [
          'I am interfacing between codex for planning and reviewing, and claude code for implementation.',
          'Codex already wrote the plan below.',
          'You do not need to change the plan.',
          profile.implementationSlices.length > 1
            ? `You own only this slice: ${slice.focus}`
            : 'Adopt the plan and implement it in the current worktree.',
        ]
      : profile.implementationSlices.length > 1
        ? [
            'I am running a codex-only orchestration flow.',
            'Codex already produced the final plan below.',
            `You are ${slice.label} and you own only this slice: ${slice.focus}`,
            'You are not alone in the codebase. Do not revert or overwrite work from earlier slices.',
            'Implement your slice completely in the current worktree, but do not create commits or push changes.',
          ]
        : [
            'I am running a codex-only orchestration flow.',
            'Codex already produced the final plan below.',
            'Implement the plan completely in the current worktree.',
            'Do not create commits or push changes.',
          ];

  return [...preamble, '', finalPlan.trim()].join('\n');
}

export function buildReviewPrompt({
  prUrl,
  stepPrompt,
  variables,
}: {
  prUrl: string;
  stepPrompt: string;
  variables: Record<string, string>;
}): string {
  return interpolateTemplate({
    template: stepPrompt,
    variables: {
      ...variables,
      pr_url: prUrl,
    },
  });
}

export function buildReviewFixPrompt({
  executor,
  finalPlan,
  reviewOutput,
}: {
  executor: ExecutorMode;
  finalPlan: string;
  reviewOutput: string;
}): string {
  return executor === 'hybrid'
    ? [
        'I am interfacing between codex for planning and reviewing, and claude code for implementation.',
        'Codex found issues in the implementation.',
        'Fix every issue in one pass without undoing unrelated changes.',
        '',
        '## Final plan',
        finalPlan.trim(),
        '',
        '## Review findings',
        reviewOutput.trim(),
      ].join('\n')
    : [
        'I am running a codex-only orchestration flow.',
        'A codex reviewer found issues in the implementation.',
        'Fix every issue in one pass without undoing unrelated changes.',
        'Do not commit or push.',
        '',
        '## Final plan',
        finalPlan.trim(),
        '',
        '## Review findings',
        reviewOutput.trim(),
      ].join('\n');
}

export function buildCiDiagnosisPrompt({
  prNumber,
  runId,
}: {
  prNumber: number | null;
  runId: string;
}): string {
  const prSegment = prNumber === null ? 'the current PR' : `PR #${prNumber}`;
  return `CI failed on ${prSegment}. Run 'gh run view ${runId} --log-failed' to get the failure details. Investigate the failure against the codebase. Produce a file-by-file fix plan with exact changes.`;
}

export function buildCiFixPrompt({
  diagnosisOutput,
  executor,
  finalPlan,
}: {
  diagnosisOutput: string;
  executor: ExecutorMode;
  finalPlan: string;
}): string {
  return executor === 'hybrid'
    ? [
        'I am interfacing between codex for planning and reviewing, and claude code for implementation.',
        'Codex produced the CI failure fix plan below.',
        'Apply the fixes only.',
        '',
        '## Final implementation plan',
        finalPlan.trim(),
        '',
        '## CI diagnosis',
        diagnosisOutput.trim(),
      ].join('\n')
    : [
        'I am running a codex-only orchestration flow.',
        'A codex diagnosis agent produced the CI failure fix plan below.',
        'Apply the fixes only. Do not commit or push.',
        '',
        '## Final implementation plan',
        finalPlan.trim(),
        '',
        '## CI diagnosis',
        diagnosisOutput.trim(),
      ].join('\n');
}

export function parseCodexJobId({ output }: { output: string }): string {
  const match = output.match(/Job started:\s+([a-z0-9]+)/i);
  if (!match?.[1]) {
    throw new Error(`Could not parse codex-agent job id from output:\n${output}`);
  }
  return match[1];
}

export function parsePullRequestUrl({ output }: { output: string }): string {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (!match) {
    throw new Error(`Could not parse PR URL from output:\n${output}`);
  }
  return match[0];
}

export function parsePullRequestNumber({ prUrl }: { prUrl: string }): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match?.[1]) {
    return null;
  }
  return Number(match[1]);
}

export function isSuccessfulReview({ reviewOutput }: { reviewOutput: string }): boolean {
  return (
    reviewOutput.includes('LGTM - ready for local testing.') ||
    reviewOutput.includes('REVIEW_STATUS: PASS')
  );
}

export function looksLikeTransientModelFailure({ output }: { output: string }): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("you've hit your limit") ||
    normalized.includes('rate limit') ||
    normalized.includes('model is not supported') ||
    normalized.includes('unsupported model') ||
    normalized.includes('service unavailable')
  );
}

export function getModelCandidates({
  attempts,
  kind,
  repeatedReviewFindings = false,
}: {
  attempts: number;
  kind: ModelTaskKind;
  repeatedReviewFindings?: boolean | undefined;
}): ModelSelection[] {
  if (kind === 'planning' || kind === 'review' || kind === 'diagnosis') {
    return [
      { model: 'gpt-5.4', reasoning: 'xhigh' },
      { model: 'gpt-5.3-codex-spark', reasoning: 'xhigh' },
    ];
  }

  if (attempts >= 2 || repeatedReviewFindings) {
    return [
      { model: 'gpt-5.4', reasoning: 'xhigh' },
      { model: 'gpt-5.3-codex-spark', reasoning: 'low' },
    ];
  }

  return [
    { model: 'gpt-5.3-codex-spark', reasoning: 'low' },
    { model: 'gpt-5.4', reasoning: 'xhigh' },
  ];
}
