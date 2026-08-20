import type { Config } from '../config/index.js';
import type { InstructionStatus, PullRequestSummary } from '../repo/index.js';
import { resolveReviewSources } from '../review_source.js';
import type { ReviewSourceIdentity, ReviewSourceMarkers } from '../config/index.js';
import type { DoctorReadinessStatus, GateReadinessDiagnostics, LifecycleDiagnostics } from './types.js';

export type WorkflowStageStatus = 'ready' | 'blocked' | 'unconfigured' | 'manual' | 'disabled' | 'needs-action' | 'unavailable';

export type WorkflowStageId = 'lifecycle' | 'issue-start' | 'quality-gates' | 'review' | 'publication' | 'ui-audit' | 'shipping';

export interface WorkflowStage {
  stage: WorkflowStageId;
  status: WorkflowStageStatus;
  detail: string;
  nextAction: string | null;
}

export type WorkflowReviewState = 'unavailable' | 'provider-reviewers' | 'local-lanes' | 'evidence-ready';

export type WorkflowEvidenceState = 'not-applicable' | 'missing' | 'present';

export interface WorkflowReviewSourceReadiness {
  id: string;
  identity: ReviewSourceIdentity;
  markers: ReviewSourceMarkers;
  blocking: boolean;
  expected: string[];
  readiness: DoctorReadinessStatus;
  detail: string;
}

export interface WorkflowReviewReadiness {
  state: WorkflowReviewState;
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
  sources: WorkflowReviewSourceReadiness[];
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
  error?: string | null;
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
  return instructions.harnesses.filter(harness => harness.installed).map(harness => harness.host);
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
  if (input.dirty.error) {
    return {
      stage: 'issue-start',
      status: 'unavailable',
      detail: `The working tree state could not be observed: ${input.dirty.error}. An unobserved checkout is not reported as clean.`,
      nextAction: 'Fix git availability or repository access, then rerun `aie doctor --json`.',
    };
  }
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
  // Provider reviewer names only count when the selected adapter actually runs provider reviewers.
  const providerAdapterActive = reviewAgent.adapter !== 'local' && reviewAgent.adapter !== 'shadow';
  const providerReviewers = !providerAdapterActive ? [] : reviewAgent.reviewers.filter(name => name.trim() !== '');
  const lanesConfigured = reviewAgent.configuredLanes.length > 0 || reviewAgent.localRunner.configured;
  const lanesRunnable = lanesConfigured && reviewAgent.localRunner.readiness === 'ready';
  // Only known lane ids count as evidence; lock files, raw-output captures, or unrelated JSON never do.
  const knownLanes = new Set([...reviewAgent.requiredLanes, ...reviewAgent.configuredLanes]);
  const evidenceLanes = input.evidence.lanes.filter(lane => knownLanes.has(lane));
  const evidenceState: WorkflowEvidenceState = !lanesConfigured || input.evidence.head === null
    ? 'not-applicable'
    : evidenceLanes.length > 0
      ? 'present'
      : 'missing';
  const evidenceCoversRequired = reviewAgent.requiredLanes.length > 0 && reviewAgent.requiredLanes.every(lane => evidenceLanes.includes(lane));
  const state: WorkflowReviewState = lanesRunnable && evidenceState === 'present' && evidenceCoversRequired
    ? 'evidence-ready'
    : lanesRunnable
      ? 'local-lanes'
      : providerReviewers.length > 0
        ? 'provider-reviewers'
        : 'unavailable';
  const publisher = input.config.providers.review.publisher;
  // Doctor has no live provider record, so per-source readiness reads the
  // same local signals every other doctor review check already reads: local
  // runner readiness and recorded local evidence for lane sources, and
  // configuredness for reviewer sources. This mirrors buildGateReadinessDiagnostics'
  // reviewAgent readiness, just scoped to one configured source at a time.
  const sources: WorkflowReviewSourceReadiness[] = resolveReviewSources(input.config).map(source => {
    if (source.identity === 'lane') {
      if (reviewAgent.localRunner.readiness !== 'ready') {
        return { id: source.id, identity: source.identity, markers: source.markers, blocking: source.blocking, expected: [...source.expected], readiness: reviewAgent.localRunner.readiness, detail: `Local review lane runner readiness is ${reviewAgent.localRunner.readiness}.` };
      }
      const missing = source.expected.filter(laneId => !input.evidence.lanes.includes(laneId));
      return {
        id: source.id,
        identity: source.identity,
        markers: source.markers,
        blocking: source.blocking,
        expected: [...source.expected],
        readiness: missing.length === 0 ? 'ready' : 'missing',
        detail: missing.length === 0 ? `Current-head evidence covers all ${source.expected.length} expected lane(s).` : `Current-head evidence is missing: ${missing.join(', ')}.`,
      };
    }
    const configured = source.expected.length > 0;
    return {
      id: source.id,
      identity: source.identity,
      markers: source.markers,
      blocking: source.blocking,
      expected: [...source.expected],
      readiness: configured ? 'ready' : 'missing',
      detail: configured ? `${source.expected.length} reviewer identity(ies) configured.` : 'No reviewer identities are configured for this source.',
    };
  });
  return {
    state,
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
      lanes: evidenceLanes,
    },
    sources,
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
  if (review.state === 'unavailable') {
    return {
      stage: 'review',
      status: 'unavailable',
      detail: 'No real agent harness or external reviewer is configured. Review execution is unavailable.',
      nextAction: 'Configure OpenCode, Codex, Claude Code, Grok Build, or Cursor for native review, or add a supported external reviewer.',
    };
  }
  const description = review.state === 'evidence-ready'
    ? `Local review lanes are runnable and current-head evidence covers every required lane (${review.evidence.lanes.length} lane(s)).`
    : review.state === 'local-lanes'
      ? `Local review lanes are configured and runnable (${review.lanes.configured.length} configured, ${review.lanes.required.length} required); current-head evidence does not yet cover every required lane.`
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
  if (audit.agentBrowser.state === 'present-but-failing') {
    return {
      stage: 'ui-audit',
      status: 'needs-action',
      detail: 'Manual UI audit is enabled but agent-browser failed its capability probe.',
      nextAction: 'Repair the agent-browser install or use fallback browser automation manually.',
    };
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
