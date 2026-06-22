import type { Config, ConfigLoadResult, ValidationError } from '../config/index.js';
import { getDefaults, loadConfigFile } from '../config/index.js';
import { configToExecutorPolicy } from '../config_policy.js';
import type { GateStatusResult } from '../gates/index.js';
import { buildGateStatus } from '../gates/index.js';
import { computeQueueFromWorkItems, type Queue, type QueueItem } from '../queue/index.js';
import type { ReviewGateResult } from '../review.js';
import { runReviewGate } from '../review.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { RepoState } from '../core/repo_state.js';
import type { ReviewItem } from '../core/review_item.js';
import type { WorkItem } from '../core/work_item.js';
import { githubIssueNumber } from '../providers/github/github_work_codec.js';
import { createGitHubReviewProvider, type CurrentGitHubReview } from '../providers/github/github_review_provider.js';
import { createLocalGitRepositoryProvider } from '../providers/local/local_git_provider.js';
import type { BranchInspection, RepositoryProvider, RepositoryProviderCapabilities } from '../providers/repository_provider.js';
import type { ReviewProvider, ReviewProviderCapabilities } from '../providers/review_provider.js';
import type { WorkProvider, WorkProviderCapabilities } from '../providers/work_provider.js';
import { createWorkProvider } from '../providers/work_provider_adapters.js';

export type StatusDecisionState = 'continue' | 'stop' | 'wait' | 'unknown';
export type StatusReasonCode =
  | 'config-invalid'
  | 'repository-unavailable'
  | 'work-provider-unavailable'
  | 'multiple-active-work'
  | 'dirty-checkout'
  | 'linked-worktree'
  | 'open-review-before-new-work'
  | 'active-work-complete'
  | 'review-changes-requested'
  | 'pending-gates'
  | 'pending-review'
  | 'ready-to-ship'
  | 'continue-active-work'
  | 'start-next-work'
  | 'no-ready-work';

export interface ProviderStatus {
  id: string;
  capabilities: WorkProviderCapabilities | RepositoryProviderCapabilities | ReviewProviderCapabilities;
}

export interface StatusWorkSummary {
  key: WorkItem['key'];
  displayId: string;
  number: number | null;
  title: string;
  url: string | null;
  state: WorkItem['state'];
  effectiveStatus: QueueItem['effectiveStatus'];
  openBlockers: Array<number | string>;
  priority: WorkItem['priority'];
  checklist: WorkItem['checklist'];
}

export interface StatusQueueSummary {
  total: number;
  inProgress: number;
  ready: number;
  blocked: number;
  drift: number;
  multipleInProgress: boolean;
  cycles: Queue['cycles'];
}

export interface StatusReviewState {
  state: 'available' | 'none' | 'unavailable';
  item: ReviewItem | null;
  warning: string | null;
}

export interface StatusGateState {
  configured: number;
  failed: number;
  unknown: number;
  notRecorded: number;
  verified: number;
  stale: number;
  requiredBlocking: number;
  supplyChainStopConditions: string[];
  result: GateStatusResult;
}

export interface StatusDecision {
  state: StatusDecisionState;
  reasonCodes: StatusReasonCode[];
  nextCommand: string;
  summary: string;
}

export interface StatusResult {
  ok: boolean;
  command: 'status';
  timestamp: string;
  providers: {
    work: ProviderStatus;
    repository: ProviderStatus;
    review: ProviderStatus;
  };
  config: {
    path: string;
    present: boolean;
    valid: boolean;
    errors: ValidationError[];
  };
  repository: RepoState | null;
  currentBranch: string | null;
  expectedBranch: BranchInspection | null;
  queue: {
    available: boolean;
    error: string | null;
    summary: StatusQueueSummary;
    activeWork: StatusWorkSummary[];
    nextWork: StatusWorkSummary | null;
    blockedWork: StatusWorkSummary[];
  };
  review: StatusReviewState;
  gates: StatusGateState;
  reviewGate: ReviewGateResult | null;
  decision: StatusDecision;
}

export interface StatusServiceContext {
  configLoad: ConfigLoadResult;
  config: Config;
  policy: ExecutorPolicy;
  workProvider: WorkProvider;
  repositoryProvider: RepositoryProvider;
  reviewProvider: ReviewProvider;
  readCurrentReview: () => Promise<CurrentGitHubReview>;
  cwd?: string;
  now?: () => Date;
}

interface QueueState {
  available: boolean;
  error: string | null;
  queue: Queue;
}

const EMPTY_QUEUE: Queue = {
  items: [],
  inProgressCount: 0,
  readyCount: 0,
  blockedCount: 0,
  driftCount: 0,
  multipleInProgress: false,
  cycles: [],
  milestoneGroups: [],
};

export async function createStatusContext(options: { cwd?: string } = {}): Promise<StatusServiceContext> {
  const configLoad = await loadConfigFile(options.cwd);
  const config = configLoad.ok && configLoad.config ? configLoad.config : getDefaults();
  const policy = configToExecutorPolicy(config);
  const workProvider = createWorkProvider(config.providers.work.kind, { cwd: options.cwd });
  const repositoryProvider = createLocalGitRepositoryProvider({ cwd: options.cwd });
  const githubReviewProvider = createGitHubReviewProvider({ cwd: options.cwd });
  return {
    configLoad,
    config,
    policy,
    workProvider,
    repositoryProvider,
    reviewProvider: githubReviewProvider,
    readCurrentReview: () => githubReviewProvider.findCurrentReview(),
    cwd: options.cwd,
  };
}

export async function buildStatus(context: StatusServiceContext): Promise<StatusResult> {
  if (!context.configLoad.ok) return configErrorStatus(context);

  const repository = await inspectRepository(context);
  const queueState = await inspectQueue(context);
  const activeItems = queueState.queue.items.filter(item => item.effectiveStatus === 'InProgress');
  const nextItem = queueState.queue.items.find(item => item.effectiveStatus === 'Ready') ?? null;
  const selectedItem = activeItems.length === 1 ? activeItems[0] : nextItem;
  const expectedBranch = selectedItem ? await inspectExpectedBranch(context, selectedItem.workItem) : null;
  const review = await inspectReview(context);
  const gates = summarizeGates(buildGateStatus(context.config, { evidenceRoot: repository?.root ?? context.configLoad.root }));
  const reviewGate = activeItems.length === 1 ? runReviewGate(context.config, { issueNumber: githubIssueNumber(activeItems[0].workItem), repoRoot: repository?.root ?? context.configLoad.root }) : null;
  const decision = decideStatus({ context, repository, queueState, activeItems, nextItem, review, gates, reviewGate });

  return {
    ok: true,
    command: 'status',
    timestamp: (context.now ?? (() => new Date()))().toISOString(),
    providers: providerStatus(context),
    config: configStatus(context.configLoad),
    repository,
    currentBranch: repository?.activeRef?.kind === 'branch' ? repository.activeRef.name : null,
    expectedBranch,
    queue: {
      available: queueState.available,
      error: queueState.error,
      summary: queueSummary(queueState.queue),
      activeWork: activeItems.map(workSummary),
      nextWork: nextItem ? workSummary(nextItem) : null,
      blockedWork: queueState.queue.items.filter(item => item.effectiveStatus === 'Blocked').map(workSummary),
    },
    review,
    gates,
    reviewGate,
    decision,
  };
}

function configErrorStatus(context: StatusServiceContext): StatusResult {
  const gates = summarizeGates(buildGateStatus(getDefaults(), { evidenceRoot: context.configLoad.root }));
  return {
    ok: false,
    command: 'status',
    timestamp: (context.now ?? (() => new Date()))().toISOString(),
    providers: providerStatus(context),
    config: configStatus(context.configLoad),
    repository: null,
    currentBranch: null,
    expectedBranch: null,
    queue: { available: false, error: 'Trusted Executor config is invalid.', summary: queueSummary(EMPTY_QUEUE), activeWork: [], nextWork: null, blockedWork: [] },
    review: { state: 'unavailable', item: null, warning: 'Trusted Executor config is invalid, so review state was not loaded.' },
    gates,
    reviewGate: null,
    decision: { state: 'stop', reasonCodes: ['config-invalid'], nextCommand: 'aie init . --dry-run --force', summary: 'Fix the selected Executor config before continuing Executor work.' },
  };
}

function providerStatus(context: StatusServiceContext): StatusResult['providers'] {
  return {
    work: { id: context.workProvider.id, capabilities: context.workProvider.capabilities() },
    repository: { id: context.repositoryProvider.id, capabilities: context.repositoryProvider.capabilities() },
    review: { id: context.reviewProvider.id, capabilities: context.reviewProvider.capabilities() },
  };
}

function configStatus(load: ConfigLoadResult): StatusResult['config'] {
  return { path: load.path, present: load.present, valid: load.ok, errors: load.errors };
}

async function inspectRepository(context: StatusServiceContext): Promise<RepoState | null> {
  try {
    return await context.repositoryProvider.inspect(context.policy);
  } catch {
    return null;
  }
}

async function inspectQueue(context: StatusServiceContext): Promise<QueueState> {
  try {
    const items = await context.workProvider.listOpenWorkItems();
    return { available: true, error: null, queue: computeQueueFromWorkItems(items, context.config) };
  } catch (error: unknown) {
    return { available: false, error: error instanceof Error ? error.message : String(error), queue: EMPTY_QUEUE };
  }
}

async function inspectExpectedBranch(context: StatusServiceContext, item: WorkItem): Promise<BranchInspection | null> {
  try {
    return await context.repositoryProvider.inspectBranch(item, context.policy);
  } catch {
    return null;
  }
}

async function inspectReview(context: StatusServiceContext): Promise<StatusReviewState> {
  try {
    const current = await context.readCurrentReview();
    return current.item ? { state: 'available', item: current.item, warning: current.warning } : { state: 'none', item: null, warning: current.warning };
  } catch (error: unknown) {
    return { state: 'unavailable', item: null, warning: error instanceof Error ? error.message : String(error) };
  }
}

function queueSummary(queue: Queue): StatusQueueSummary {
  return { total: queue.items.length, inProgress: queue.inProgressCount, ready: queue.readyCount, blocked: queue.blockedCount, drift: queue.driftCount, multipleInProgress: queue.multipleInProgress, cycles: queue.cycles };
}

function workSummary(item: QueueItem): StatusWorkSummary {
  let number: number | null = null;
  try { number = githubIssueNumber(item.workItem); } catch { number = null; }
  return { key: item.workItem.key, displayId: item.workItem.displayId, number, title: item.workItem.title, url: item.workItem.url, state: item.workItem.state, effectiveStatus: item.effectiveStatus, openBlockers: item.openBlockers, priority: item.workItem.priority, checklist: item.workItem.checklist };
}

function summarizeGates(result: GateStatusResult): StatusGateState {
  const requiredBlocking = result.gates.filter(gate => gate.requirement === 'required' && gate.status !== 'passed' && gate.status !== 'skipped').length;
  const supplyChainStopConditions = result.gates.filter(gate => gate.supplyChainSensitive && gate.status !== 'passed' && gate.status !== 'skipped').map(gate => gate.name);
  return { configured: result.summary.total, failed: result.summary.failed, unknown: result.summary.unknown, notRecorded: result.summary.notRecorded, verified: result.summary.verified, stale: result.summary.stale, requiredBlocking, supplyChainStopConditions, result };
}

function decideStatus(input: { context: StatusServiceContext; repository: RepoState | null; queueState: QueueState; activeItems: QueueItem[]; nextItem: QueueItem | null; review: StatusReviewState; gates: StatusGateState; reviewGate: ReviewGateResult | null }): StatusDecision {
  if (!input.repository?.root) return { state: 'stop', reasonCodes: ['repository-unavailable'], nextCommand: 'aie doctor --json', summary: 'Run Executor from a valid git repository checkout.' };
  if (!input.queueState.available) return { state: 'unknown', reasonCodes: ['work-provider-unavailable'], nextCommand: 'aie doctor --json', summary: 'Work provider state is unavailable; Executor cannot safely continue.' };
  if (input.activeItems.length > 1) return { state: 'stop', reasonCodes: ['multiple-active-work'], nextCommand: 'aie queue --json', summary: 'Multiple active work items exist; fix status labels before continuing.' };
  if (input.repository.dirty.dirty) return { state: 'stop', reasonCodes: ['dirty-checkout'], nextCommand: 'git status', summary: 'The checkout has uncommitted changes that must be resolved before autonomous continuation.' };
  if (input.context.config.noWorktree && input.repository.worktree.linked) return { state: 'stop', reasonCodes: ['linked-worktree'], nextCommand: 'aie doctor --json', summary: 'Repository policy disables linked worktrees; continue from the primary checkout.' };

  if (input.activeItems.length === 0 && input.review.item && (input.review.item.state === 'open' || input.review.item.state === 'draft')) {
    return { state: 'wait', reasonCodes: ['open-review-before-new-work'], nextCommand: `aie pr gate ${input.review.item.key.id} --json`, summary: 'An open pull request exists on the current branch; resolve it before starting new work.' };
  }

  if (input.activeItems.length === 1) return decideActiveWork(input.activeItems[0], input);
  if (input.nextItem) return { state: 'continue', reasonCodes: ['start-next-work'], nextCommand: 'aie start next', summary: `Start ${input.nextItem.workItem.displayId}; it is the next ready work item.` };
  return { state: 'stop', reasonCodes: ['no-ready-work'], nextCommand: 'aie queue --json', summary: 'No ready work is available; the queue is empty or all open work is blocked.' };
}

function decideActiveWork(activeItem: QueueItem, input: { review: StatusReviewState; gates: StatusGateState; reviewGate: ReviewGateResult | null }): StatusDecision {
  const issueNumber = githubIssueNumber(activeItem.workItem);
  const review = input.review.item;
  if (review?.state === 'merged') return { state: 'continue', reasonCodes: ['active-work-complete'], nextCommand: `aie complete ${issueNumber}`, summary: `Complete ${activeItem.workItem.displayId}; its pull request is merged.` };
  if (review?.reviewDecision === 'changes-requested' || review?.feedback.some(item => item.source === 'thread')) return { state: 'continue', reasonCodes: ['review-changes-requested'], nextCommand: `aie pr gate ${review.key.id} --json`, summary: 'Address requested PR feedback, then rerun the PR gate.' };
  if (review && input.gates.requiredBlocking > 0) return { state: 'continue', reasonCodes: ['pending-gates'], nextCommand: 'aie gates status --json', summary: 'Required gate evidence is missing, stale, unknown, or failed.' };
  if (review && input.reviewGate && input.reviewGate.evidence.status !== 'passed') return { state: 'continue', reasonCodes: ['pending-review'], nextCommand: `aie review gate ${issueNumber} --json`, summary: 'Review-agent evidence is not recorded as passed.' };
  if (review && review.mergeability === 'mergeable' && review.reviewDecision === 'approved') return { state: 'continue', reasonCodes: ['ready-to-ship'], nextCommand: `aie pr gate ${review.key.id} --json`, summary: 'PR state is mergeable and approved; run the PR gate before shipping.' };
  return { state: 'continue', reasonCodes: ['continue-active-work'], nextCommand: `aie branch check ${issueNumber}`, summary: `Continue implementation for active work ${activeItem.workItem.displayId}.` };
}
