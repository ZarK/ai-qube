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
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { CurrentReviewForge, ReviewForgeProvider, ReviewForgeProviderCapabilities } from '../providers/review_forge_provider.js';
import { createLocalGitRepositoryProvider } from '../providers/local/local_git_provider.js';
import type { BranchInspection, RepositoryProvider, RepositoryProviderCapabilities } from '../providers/repository_provider.js';
import type { ReviewProvider, ReviewProviderCapabilities } from '../providers/review_provider.js';
import type { WorkProvider, WorkProviderCapabilities } from '../providers/work_provider.js';
import { createWorkProvider } from '../providers/work_provider_adapters.js';
import { maybeWorkItemKeyNumber } from '../core/work_item.js';
import { workProviderOptions } from './lifecycle_common.js';

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
  | 'continue-dirty-active-work'
  | 'start-next-work'
  | 'read-only-work-provider'
  | 'no-ready-work';

export interface ProviderStatus {
  id: string;
  capabilities: WorkProviderCapabilities | RepositoryProviderCapabilities | ReviewProviderCapabilities | ReviewForgeProviderCapabilities;
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

interface AiuStatusCommandRef {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
}

interface AiuStatusWorkItem {
  readonly kind: 'work-item';
  readonly status: 'pass' | 'unknown';
  readonly id: string;
  readonly title: string;
  readonly lifecycle: 'active' | 'ready' | 'blocked';
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  readonly blockers: readonly string[];
  readonly nextAction?: AiuStatusCommandRef;
}

interface AiuStatusWorkQueue {
  readonly kind: 'work-queue';
  readonly status: 'pass' | 'unknown';
  readonly summary: string;
  readonly activeItems: readonly AiuStatusWorkItem[];
  readonly readyItems: readonly AiuStatusWorkItem[];
  readonly blockedItems: readonly AiuStatusWorkItem[];
  readonly unknownItems: readonly AiuStatusWorkItem[];
}

interface AiuStatusReview {
  readonly kind: 'review';
  readonly status: 'pass' | 'fail';
  readonly summary: string;
  readonly targetId: string;
  readonly reviewStatus: 'active' | 'approved' | 'changes-requested' | 'blocked' | 'none';
  readonly unresolvedFeedbackCount: number;
  readonly nextAction?: AiuStatusCommandRef;
}

interface AiuStatusContinuationPolicy {
  readonly kind: 'continuation-policy';
  readonly status: 'pass';
  readonly summary: string;
  readonly allowedModes: readonly ('continue' | 'repair' | 'wait' | 'stop')[];
  readonly stopOnUnknownState: true;
  readonly stopOnStaleState: true;
  readonly stopOnSupplyChainApprovalBlock: true;
  readonly allowProviderMutation: false;
  readonly allowBackgroundScheduling: false;
}

type AiuStatusState = AiuStatusContinuationPolicy | AiuStatusWorkQueue | AiuStatusReview;

export interface StatusResult {
  schemaVersion: 1;
  states: readonly AiuStatusState[];
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
  reviewProvider: ReviewProvider | ReviewForgeProvider;
  readCurrentReview: () => Promise<CurrentReviewForge>;
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
  const workProvider = await createWorkProvider(config.providers.work.kind, workProviderOptions(config, { cwd: options.cwd }));
  const repositoryProvider = createLocalGitRepositoryProvider({ cwd: options.cwd });
  const reviewForgeProvider = await createReviewForgeProvider(config.providers.review.kind, { cwd: options.cwd, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  return {
    configLoad,
    config,
    policy,
    workProvider,
    repositoryProvider,
    reviewProvider: reviewForgeProvider,
    readCurrentReview: () => reviewForgeProvider.findCurrentReview(),
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
  const activeIssueNumber = activeItems.length === 1 ? maybeWorkItemKeyNumber(activeItems[0].workItem.key) : null;
  const reviewGate = activeIssueNumber !== null ? runReviewGate(context.config, { issueNumber: activeIssueNumber, repoRoot: repository?.root ?? context.configLoad.root }) : null;
  const decision = decideStatus({ context, repository, queueState, activeItems, nextItem, review, gates, reviewGate });
  const queue: StatusResult['queue'] = {
    available: queueState.available,
    error: queueState.error,
    summary: queueSummary(queueState.queue),
    activeWork: activeItems.map(workSummary),
    nextWork: nextItem ? workSummary(nextItem) : null,
    blockedWork: queueState.queue.items.filter(item => item.effectiveStatus === 'Blocked').map(workSummary),
  };

  return {
    schemaVersion: 1,
    states: buildAiuStatusStates({ queue, review, decision, autonomousMode: context.config.autonomousMode }),
    ok: true,
    command: 'status',
    timestamp: (context.now ?? (() => new Date()))().toISOString(),
    providers: providerStatus(context),
    config: configStatus(context.configLoad),
    repository,
    currentBranch: repository?.activeRef?.kind === 'branch' ? repository.activeRef.name : null,
    expectedBranch,
    queue,
    review,
    gates,
    reviewGate,
    decision,
  };
}

function configErrorStatus(context: StatusServiceContext): StatusResult {
  const gates = summarizeGates(buildGateStatus(getDefaults(), { evidenceRoot: context.configLoad.root }));
  const queue: StatusResult['queue'] = { available: false, error: 'Trusted Executor config is invalid.', summary: queueSummary(EMPTY_QUEUE), activeWork: [], nextWork: null, blockedWork: [] };
  const review: StatusReviewState = { state: 'unavailable', item: null, warning: 'Trusted Executor config is invalid, so review state was not loaded.' };
  const decision: StatusDecision = { state: 'stop', reasonCodes: ['config-invalid'], nextCommand: 'aie init . --dry-run --force', summary: 'Fix the selected Executor config before continuing Executor work.' };
  return {
    schemaVersion: 1,
    states: buildAiuStatusStates({ queue, review, decision, autonomousMode: false }),
    ok: false,
    command: 'status',
    timestamp: (context.now ?? (() => new Date()))().toISOString(),
    providers: providerStatus(context),
    config: configStatus(context.configLoad),
    repository: null,
    currentBranch: null,
    expectedBranch: null,
    queue,
    review,
    gates,
    reviewGate: null,
    decision,
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
  const number = maybeWorkItemKeyNumber(item.workItem.key);
  return { key: item.workItem.key, displayId: item.workItem.displayId, number, title: item.workItem.title, url: item.workItem.url, state: item.workItem.state, effectiveStatus: item.effectiveStatus, openBlockers: item.openBlockers, priority: item.workItem.priority, checklist: item.workItem.checklist };
}

function buildAiuStatusStates(input: {
  queue: StatusResult['queue'];
  review: StatusReviewState;
  decision: StatusDecision;
  autonomousMode: boolean;
}): readonly AiuStatusState[] {
  const workflowBlocked = blocksAiuContinuation(input.decision);
  const currentIssueRecovery = permitsCurrentIssueRecovery(input.decision);
  const continuousShipping = input.autonomousMode && !workflowBlocked;
  const continuationEnabled = !workflowBlocked && (continuousShipping || currentIssueRecovery);
  const canRecoverWorkflow = continuationEnabled && (input.decision.state === 'continue' || input.decision.state === 'wait');
  const action = canRecoverWorkflow ? statusCommandRef(input.decision) : undefined;
  const activeStatus = canRecoverWorkflow && input.decision.state === 'continue' ? 'pass' as const : 'unknown' as const;
  const queueStatus = input.queue.available && continuationEnabled ? 'pass' as const : 'unknown' as const;
  const activeAction = input.decision.reasonCodes.includes('start-next-work') ? undefined : action;
  const readyAction = input.decision.reasonCodes.includes('start-next-work') ? action : undefined;
  const states: AiuStatusState[] = [
    Object.freeze({
      kind: 'continuation-policy',
      status: 'pass',
      summary: !input.autonomousMode
        ? currentIssueRecovery
          ? 'Continuous Shipping is off. Umpire can recover current local issue work, but it cannot ship or start Ready work.'
          : 'Continuous Shipping is off, so Umpire cannot ship or start Ready work.'
        : workflowBlocked
          ? 'Executor reports a stop condition, so Umpire must not continue workflow work.'
          : 'Continuous Shipping allows Umpire continuation within the current Executor workflow.',
      allowedModes: Object.freeze(continuationEnabled ? ['continue', 'repair', 'wait', 'stop'] as const : ['stop'] as const),
      stopOnUnknownState: true,
      stopOnStaleState: true,
      stopOnSupplyChainApprovalBlock: true,
      allowProviderMutation: false,
      allowBackgroundScheduling: false,
    }),
    Object.freeze({
      kind: 'work-queue',
      status: queueStatus,
      summary: input.decision.summary,
      activeItems: Object.freeze(input.queue.activeWork.map(item => toAiuWorkItem(item, 'active', activeStatus, activeAction))),
      readyItems: Object.freeze(continuousShipping && canRecoverWorkflow && input.decision.reasonCodes.includes('start-next-work') && input.queue.nextWork ? [toAiuWorkItem(input.queue.nextWork, 'ready', 'pass', readyAction)] : []),
      blockedItems: Object.freeze(input.queue.blockedWork.map(item => toAiuWorkItem(item, 'blocked', 'pass'))),
      unknownItems: Object.freeze([]),
    }),
  ];
  if (canRecoverWorkflow && input.review.state === 'available' && input.review.item) {
    states.push(toAiuReview(input.review.item, action));
  }
  return Object.freeze(states);
}

function permitsCurrentIssueRecovery(decision: StatusDecision): boolean {
  return decision.reasonCodes.includes('continue-active-work')
    || decision.reasonCodes.includes('continue-dirty-active-work');
}

function blocksAiuContinuation(decision: StatusDecision): boolean {
  if (decision.state === 'unknown') return true;
  if (decision.state !== 'stop') return false;
  return !decision.reasonCodes.includes('no-ready-work');
}

function toAiuWorkItem(
  item: StatusWorkSummary,
  lifecycle: AiuStatusWorkItem['lifecycle'],
  status: AiuStatusWorkItem['status'],
  nextAction?: AiuStatusCommandRef,
): AiuStatusWorkItem {
  return Object.freeze({
    kind: 'work-item',
    status,
    id: item.number === null ? item.displayId : String(item.number),
    title: item.title,
    lifecycle,
    priority: aiuPriority(item.priority),
    blockers: Object.freeze(item.openBlockers.map(String)),
    ...(nextAction ? { nextAction } : {}),
  });
}

function toAiuReview(review: ReviewItem, nextAction: AiuStatusCommandRef | undefined): AiuStatusReview {
  const reviewStatus = aiuReviewStatus(review);
  return Object.freeze({
    kind: 'review',
    status: reviewStatus === 'blocked' || reviewStatus === 'changes-requested' ? 'fail' : 'pass',
    summary: `Executor review ${review.displayId} is ${reviewStatus}.`,
    targetId: review.key.id,
    reviewStatus,
    unresolvedFeedbackCount: review.feedback.length + review.conversations.filter(conversation => !conversation.resolved).length,
    ...(nextAction ? { nextAction } : {}),
  });
}

function aiuReviewStatus(review: ReviewItem): AiuStatusReview['reviewStatus'] {
  if (review.state === 'merged') return 'approved';
  if (review.state === 'closed') return 'none';
  if (review.reviewDecision === 'changes-requested' || review.feedback.some(item => item.source === 'thread')) return 'changes-requested';
  if (review.mergeability === 'blocked' || review.mergeability === 'conflicting') return 'blocked';
  if (review.reviewDecision === 'approved') return 'approved';
  return 'active';
}

function aiuPriority(priority: StatusWorkSummary['priority']): AiuStatusWorkItem['priority'] {
  if (priority === 'critical' || priority === 'high' || priority === 'low') return priority;
  return 'normal';
}

function statusCommandRef(decision: StatusDecision): AiuStatusCommandRef | undefined {
  const argv = decision.nextCommand.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return undefined;
  return Object.freeze({
    id: decision.reasonCodes[0] ?? 'aie-status',
    argv: Object.freeze(argv) as readonly [string, ...string[]],
  });
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
  if (input.context.config.noWorktree && input.repository.worktree.linked) return { state: 'stop', reasonCodes: ['linked-worktree'], nextCommand: 'aie doctor --json', summary: 'Repository policy disables linked worktrees; continue from the primary checkout.' };
  if (input.repository.dirty.dirty) {
    if (input.activeItems.length === 1) {
      return {
        state: 'continue',
        reasonCodes: ['continue-dirty-active-work'],
        nextCommand: 'git status',
        summary: `Recover local changes for ${input.activeItems[0].workItem.displayId} before continuing its issue workflow.`,
      };
    }
    return { state: 'stop', reasonCodes: ['dirty-checkout'], nextCommand: 'git status', summary: 'The checkout has uncommitted changes that are not tied to one active issue.' };
  }
  if (input.activeItems.length === 0 && input.review.item && (input.review.item.state === 'open' || input.review.item.state === 'draft')) {
    return { state: 'wait', reasonCodes: ['open-review-before-new-work'], nextCommand: `aie pr gate ${input.review.item.key.id} --json`, summary: 'An open pull request exists on the current branch; resolve it before starting new work.' };
  }

  if (input.activeItems.length === 1) return decideActiveWork(input.activeItems[0], input);
  if (input.nextItem && !canApplyLifecycle(input.context.workProvider)) return readOnlyProviderDecision(input.context.workProvider.id, `Inspect ready work ${input.nextItem.workItem.displayId} from the configured ${input.context.workProvider.id} provider.`);
  if (input.nextItem) return { state: 'continue', reasonCodes: ['start-next-work'], nextCommand: 'aie start next', summary: `Start ${input.nextItem.workItem.displayId}; it is the next ready work item.` };
  return { state: 'stop', reasonCodes: ['no-ready-work'], nextCommand: 'aie queue --json', summary: 'No ready work is available; the queue is empty or all open work is blocked.' };
}

function canApplyLifecycle(provider: WorkProvider): boolean {
  const capabilities = provider.capabilities();
  return capabilities.planLifecycleMutations && capabilities.applyLifecycleMutations;
}

function readOnlyProviderDecision(providerId: string, summary: string): StatusDecision {
  return {
    state: 'stop',
    reasonCodes: ['read-only-work-provider'],
    nextCommand: 'aie queue --json',
    summary: `${summary} Lifecycle mutation commands require a provider with tested issue-number lifecycle support; ${providerId} is currently read-only.`,
  };
}

function decideActiveWork(activeItem: QueueItem, input: { context: StatusServiceContext; review: StatusReviewState; gates: StatusGateState; reviewGate: ReviewGateResult | null }): StatusDecision {
  const issueNumber = maybeWorkItemKeyNumber(activeItem.workItem.key);
  const review = input.review.item;
  const lifecycleSupported = canApplyLifecycle(input.context.workProvider);
  if (!lifecycleSupported && review?.state !== 'open' && review?.state !== 'draft') return readOnlyProviderDecision(input.context.workProvider.id, `Active work ${activeItem.workItem.displayId} uses provider-native keys.`);
  if (review?.state === 'merged') return { state: 'continue', reasonCodes: ['active-work-complete'], nextCommand: `aie complete ${issueNumber}`, summary: `Complete ${activeItem.workItem.displayId}; its pull request is merged.` };
  if (review?.reviewDecision === 'changes-requested' || review?.feedback.some(item => item.source === 'thread')) return { state: 'continue', reasonCodes: ['review-changes-requested'], nextCommand: `aie pr gate ${review.key.id} --json`, summary: 'Address requested PR feedback, then rerun the PR gate.' };
  if (review && input.gates.requiredBlocking > 0) return { state: 'continue', reasonCodes: ['pending-gates'], nextCommand: 'aie gates status --json', summary: 'Required gate evidence is missing, stale, unknown, or failed.' };
  if (review && input.reviewGate && issueNumber !== null && !input.reviewGate.reviewAvailable) return { state: 'stop', reasonCodes: ['pending-review'], nextCommand: 'aie doctor --json', summary: input.reviewGate.nextAction };
  if (review && input.reviewGate && issueNumber !== null && input.reviewGate.evidence.status !== 'passed') return { state: 'continue', reasonCodes: ['pending-review'], nextCommand: `aie review gate ${issueNumber} --json`, summary: 'Review-agent evidence is not recorded as passed.' };
  if (review && review.mergeability === 'mergeable' && review.reviewDecision === 'approved') return { state: 'continue', reasonCodes: ['ready-to-ship'], nextCommand: `aie pr gate ${review.key.id} --json`, summary: 'PR state is mergeable and approved; run the PR gate before shipping.' };
  if (!lifecycleSupported || issueNumber === null) return readOnlyProviderDecision(input.context.workProvider.id, `Continue active work ${activeItem.workItem.displayId} outside GitHub issue lifecycle commands.`);
  return { state: 'continue', reasonCodes: ['continue-active-work'], nextCommand: `aie branch check ${issueNumber}`, summary: `Continue implementation for active work ${activeItem.workItem.displayId}.` };
}
