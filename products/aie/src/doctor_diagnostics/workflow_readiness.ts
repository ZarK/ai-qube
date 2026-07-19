import type { Config } from '../config/index.js';
import type { InstructionStatus, PullRequestSummary } from '../repo/index.js';
import type { DoctorReadinessStatus, GateReadinessDiagnostics, LifecycleDiagnostics } from './types.js';

export type WorkflowStageStatus = 'ready' | 'blocked' | 'unconfigured' | 'fallback-only' | 'manual' | 'disabled' | 'needs-action' | 'unavailable';

export type WorkflowStageId = 'lifecycle' | 'issue-start' | 'quality-gates' | 'review' | 'publication' | 'ui-audit' | 'shipping';

export interface WorkflowStage {
  stage: WorkflowStageId;
  status: WorkflowStageStatus;
  detail: string;
  nextAction: string | null;
}

export type WorkflowReviewState = 'fallback-only' | 'provider-reviewers' | 'local-lanes' | 'evidence-ready';

export type WorkflowEvidenceState = 'not-applicable' | 'missing' | 'present';

export interface WorkflowReviewReadiness {
  state: WorkflowReviewState;
  fallbackPromptAvailable: boolean;
  fallbackEnforcesReview: boolean;
  providerReviewers: string[];
  lanes: {
    required: string[];
    configured: string[];
    runnerReadiness: DoctorReadinessStatus;
  };
  publisher: {
    configured: boolean;
    mode: string;
  };
  evidence: {
    state: WorkflowEvidenceState;
    head: string | null;
    lanes: string[];
  };
}

export interface WorkflowShippingReadiness {
  mode: 'autonomous' | 'manual';
}

export interface WorkflowReadinessDiagnostics {
  stages: WorkflowStage[];
  review: WorkflowReviewReadiness;
  shipping: WorkflowShippingReadiness;
  selectedHosts: string[];
}

export interface WorkflowDirtyState {
  dirty: boolean;
  entries: string[];
}

export interface WorkflowEvidenceInput {
  head: string | null;
  lanes: string[];
}

export interface WorkflowReadinessInput {
  config: Config;
  configValid: boolean;
  labelsOk: boolean;
  queueDriftCount: number;
  queueMultipleInProgress: boolean;
  queueError?: string;
  lifecycle: LifecycleDiagnostics;
  gateReadiness: GateReadinessDiagnostics;
  instructions: InstructionStatus;
  dirty: WorkflowDirtyState;
  currentBranch: string;
  blockingPullRequests: PullRequestSummary[];
  evidence: WorkflowEvidenceInput;
}

export function selectedAgentHosts(instructions: InstructionStatus): string[] {
  const hosts: string[] = [];
  if (instructions.agents) hosts.push('codex');
  if (instructions.claude) hosts.push('claude-code');
  if (instructions.opencodeMakeItSo || instructions.opencodeMakeitsoAlias) hosts.push('opencode');
  return hosts;
}

function buildLifecycleStage(input: WorkflowReadinessInput): WorkflowStage {
  const problems: string[] = [];
  if (!input.configValid) problems.push('config is invalid');
  if (!input.labelsOk) problems.push('labels are unhealthy');
  if (input.queueError) problems.push(`queue check failed: ${input.queueError}`);
  if (input.queueDriftCount > 0) problems.push(`queue drift (${input.queueDriftCount})`);
  if (input.queueMultipleInProgress) problems.push('multiple issues in progress');
  if (problems.length === 0) {
    return { stage: 'lifecycle', status: 'ready', detail: 'Config, labels, and issue queue are healthy.', nextAction: null };
  }
  return {
    stage: 'lifecycle',
    status: 'needs-action',
    detail: `Lifecycle problems: ${problems.join('; ')}.`,
    nextAction: !input.configValid
      ? 'Fix the selected Executor config, then rerun `aie doctor --json`.'
      : !input.labelsOk
        ? 'Run `aie labels setup --dry-run` then `aie labels setup`.'
        : 'Run `aie deps fix --dry-run` then `aie deps fix` to repair queue state.',
  };
}

function buildIssueStartStage(input: WorkflowReadinessInput): WorkflowStage {
  const blockers: string[] = [];
  let nextAction: string | null = null;
  if (input.dirty.dirty) {
    const sample = input.dirty.entries.slice(0, 3).join(', ');
    blockers.push(`dirty primary checkout with uncommitted changes (${sample}${input.dirty.entries.length > 3 ? ', …' : ''})`);
    nextAction = nextAction ?? 'Commit, stash, or remove the uncommitted changes in the primary checkout before starting issue work.';
  }
  if (input.lifecycle.linkedWorktreeBlocked) {
    blockers.push('linked git worktree is blocked by repository policy');
    nextAction = nextAction ?? 'Switch to the primary checkout before starting issue work.';
  }
  if (input.lifecycle.openPullRequestCheckEnabled && input.blockingPullRequests.length > 0) {
    blockers.push(`open pull requests block new issue work (${input.blockingPullRequests.map(pr => `#${pr.number}`).join(', ')})`);
    nextAction = nextAction ?? 'Merge or close the blocking open pull requests before starting new issue work.';
  }
  if (!input.lifecycle.baseBranchFresh && input.config.requireBaseBranchFreshness) {
    blockers.push('local base branch is not current with the configured remote');
    nextAction = nextAction ?? 'Pull the configured base branch from its remote before starting new issue work.';
  }
  if (!input.lifecycle.branchNamingValid) {
    blockers.push('branch naming policy is invalid');
    nextAction = nextAction ?? 'Fix the branch naming pattern in the selected Executor config.';
  }
  if (blockers.length === 0) {
    return { stage: 'issue-start', status: 'ready', detail: 'A new issue branch can start from the primary checkout.', nextAction: null };
  }
  return { stage: 'issue-start', status: 'blocked', detail: `Issue start is blocked: ${blockers.join('; ')}.`, nextAction };
}

function buildQualityGateStage(input: WorkflowReadinessInput): WorkflowStage {
  const gates = input.gateReadiness.gates;
  if (gates.configured === 0) {
    return {
      stage: 'quality-gates',
      status: 'unconfigured',
      detail: 'No quality gates are configured; build and test verification is not enforced.',
      nextAction: 'Configure policy.gates entries in the selected Executor config so build and test verification runs before PRs and merges.',
    };
  }
  if (gates.invalidCommands.length > 0) {
    return {
      stage: 'quality-gates',
      status: 'needs-action',
      detail: `Configured gates have invalid commands: ${gates.invalidCommands.join(', ')}.`,
      nextAction: 'Fix the invalid gate commands in the selected Executor config.',
    };
  }
  return {
    stage: 'quality-gates',
    status: 'ready',
    detail: `${gates.configured} configured gate(s): ${gates.required} required, ${gates.advisory} advisory.`,
    nextAction: null,
  };
}

export function buildReviewReadiness(input: WorkflowReadinessInput): WorkflowReviewReadiness {
  const reviewAgent = input.gateReadiness.reviewAgent;
  const providerReviewers = reviewAgent.defaultOracle ? [] : reviewAgent.reviewers.filter(name => name.trim() !== '');
  const lanesConfigured = reviewAgent.configuredLanes.length > 0 || reviewAgent.localRunner.configured;
  const lanesRunnable = lanesConfigured && reviewAgent.localRunner.readiness === 'ready';
  const evidenceState: WorkflowEvidenceState = !lanesConfigured || input.evidence.head === null
    ? 'not-applicable'
    : input.evidence.lanes.length > 0
      ? 'present'
      : 'missing';
  const state: WorkflowReviewState = lanesRunnable && evidenceState === 'present'
    ? 'evidence-ready'
    : lanesRunnable
      ? 'local-lanes'
      : providerReviewers.length > 0
        ? 'provider-reviewers'
        : 'fallback-only';
  const publisher = input.config.providers.review.publisher;
  return {
    state,
    fallbackPromptAvailable: reviewAgent.fallbackPromptAvailable,
    fallbackEnforcesReview: false,
    providerReviewers,
    lanes: {
      required: [...reviewAgent.requiredLanes],
      configured: [...reviewAgent.configuredLanes],
      runnerReadiness: reviewAgent.localRunner.readiness,
    },
    publisher: {
      configured: publisher !== undefined,
      mode: publisher?.mode ?? 'user',
    },
    evidence: {
      state: evidenceState,
      head: input.evidence.head,
      lanes: [...input.evidence.lanes],
    },
  };
}

function buildReviewStage(review: WorkflowReviewReadiness): WorkflowStage {
  if (review.lanes.configured.length > 0 && review.lanes.runnerReadiness !== 'ready' && review.state !== 'provider-reviewers') {
    return {
      stage: 'review',
      status: 'needs-action',
      detail: `Review lanes are configured but the local runner readiness is ${review.lanes.runnerReadiness}.`,
      nextAction: 'Fix the local review runner configuration before relying on lane execution.',
    };
  }
  if (review.state === 'fallback-only') {
    return {
      stage: 'review',
      status: 'fallback-only',
      detail: 'Only the safe fallback review prompt is available; no configured provider reviewer or local review lanes enforce QUBEReview execution.',
      nextAction: 'Configure reviews.lanes with a local runner or add provider reviewers in the selected Executor config before relying on enforced review.',
    };
  }
  const description = review.state === 'evidence-ready'
    ? `Local review lanes are runnable and current-head evidence exists for ${review.evidence.lanes.length} lane(s).`
    : review.state === 'local-lanes'
      ? `Local review lanes are configured and runnable (${review.lanes.configured.length} configured, ${review.lanes.required.length} required); no current-head evidence yet.`
      : `Provider reviewers are configured (${review.providerReviewers.join(', ')}); no local review lanes run on this host.`;
  return { stage: 'review', status: 'ready', detail: description, nextAction: null };
}

function buildPublicationStage(input: WorkflowReadinessInput, review: WorkflowReviewReadiness): WorkflowStage {
  const ghAuthenticated = input.gateReadiness.prReview.ghAuthenticated;
  if (review.publisher.configured) {
    return {
      stage: 'publication',
      status: 'ready',
      detail: `A distinct review publisher identity is configured (mode ${review.publisher.mode}). Run \`aie review doctor\` for a deep publisher probe.`,
      nextAction: null,
    };
  }
  if (ghAuthenticated) {
    return {
      stage: 'publication',
      status: 'ready',
      detail: 'Provider publication uses the authenticated gh user fallback identity.',
      nextAction: null,
    };
  }
  return {
    stage: 'publication',
    status: 'unavailable',
    detail: 'No review publisher is configured and the GitHub CLI is not authenticated; provider-visible review publication cannot run.',
    nextAction: 'Run `gh auth login` or configure providers.review.publisher before publishing review feedback.',
  };
}

function buildUiAuditStage(input: WorkflowReadinessInput): WorkflowStage {
  const audit = input.gateReadiness.audit;
  if (!audit.manualUiAudit) {
    return { stage: 'ui-audit', status: 'disabled', detail: 'Manual UI audit is disabled by repository policy.', nextAction: null };
  }
  if (audit.readiness === 'ready') {
    return { stage: 'ui-audit', status: 'ready', detail: 'Manual UI audit is enabled and agent-browser is available.', nextAction: null };
  }
  return {
    stage: 'ui-audit',
    status: 'needs-action',
    detail: 'Manual UI audit is enabled but agent-browser was not found on PATH.',
    nextAction: 'Install agent-browser or use fallback browser automation manually.',
  };
}

function buildShippingStage(input: WorkflowReadinessInput): WorkflowStage {
  if (input.config.autonomousMode) {
    return { stage: 'shipping', status: 'ready', detail: 'Autonomous shipping mode is enabled.', nextAction: null };
  }
  return {
    stage: 'shipping',
    status: 'manual',
    detail: 'Manual shipping mode: merges stop for explicit confirmation. This is an explicit operating mode, not an error.',
    nextAction: null,
  };
}

export function buildWorkflowReadiness(input: WorkflowReadinessInput): WorkflowReadinessDiagnostics {
  const review = buildReviewReadiness(input);
  const stages: WorkflowStage[] = [
    buildLifecycleStage(input),
    buildIssueStartStage(input),
    buildQualityGateStage(input),
    buildReviewStage(review),
    buildPublicationStage(input, review),
    buildUiAuditStage(input),
    buildShippingStage(input),
  ];
  return {
    stages,
    review,
    shipping: { mode: input.config.autonomousMode ? 'autonomous' : 'manual' },
    selectedHosts: selectedAgentHosts(input.instructions),
  };
}
