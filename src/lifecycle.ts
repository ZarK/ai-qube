import { Config } from './config';
import { Queue } from './queue';
import { BaseRefStatus, PullRequestSummary, WorktreeStatus } from './repo';
import { isHelpToken } from './command_metadata';
import type { JsonObject } from './core/json_value';

export type LifecycleMutation = 'github' | 'git' | 'none';
export type LifecycleActionStatus = 'planned' | 'completed' | 'failed' | 'skipped';
export type LifecycleTargetType = 'issue' | 'branch' | 'repository';

export type LifecycleActionKind =
  | 'add-labels'
  | 'remove-labels'
  | 'replace-status-labels'
  | 'assign-issue'
  | 'add-comment'
  | 'close-issue'
  | 'refresh-dependent-status'
  | 'suggest-branch-name'
  | 'verify-current-branch'
  | 'create-branch'
  | 'check-worktree'
  | 'check-open-pull-requests'
  | 'check-base-branch';

export type LifecycleIssueSelection =
  | { kind: 'help' }
  | { kind: 'next' }
  | { kind: 'issue'; issueNumber: number };

export interface LifecycleActionFailure {
  operation: string;
  cause: string;
  nextAction: string;
}

export interface LifecycleAction {
  id: string;
  kind: LifecycleActionKind;
  targetType: LifecycleTargetType;
  targetId: string;
  mutation: LifecycleMutation;
  description: string;
  preconditions: string[];
  expectedResult: string;
  status: LifecycleActionStatus;
  details: JsonObject;
  failure?: LifecycleActionFailure;
}

export interface LifecyclePlan {
  ok: boolean;
  command: string;
  dryRun: boolean;
  checkOnly: boolean;
  actions: LifecycleAction[];
  summary: LifecycleActionSummary;
  preStartPolicy?: PreStartPolicyResult;
}

export interface LifecycleActionSummary {
  ok: boolean;
  plannedCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  completedActions: LifecycleAction[];
  failedActions: LifecycleAction[];
  skippedActions: LifecycleAction[];
  recoveryCommand?: string;
}

export interface PreStartPolicyCheck {
  name: 'worktree' | 'open-pull-requests' | 'base-ref';
  ok: boolean;
  skipped: boolean;
  reason?: string;
  action: LifecycleAction;
}

export interface PreStartPolicyResult {
  ok: boolean;
  bypassed: boolean;
  reason?: string;
  worktree: WorktreeStatus;
  baseRef: BaseRefStatus;
  blockingPullRequests: PullRequestSummary[];
  checks: PreStartPolicyCheck[];
  blockers: string[];
  nextActions: string[];
}

export type LifecycleActionHandler = (action: LifecycleAction) => Promise<void>;

export interface LifecycleExecutionOptions {
  dryRun: boolean;
  checkOnly?: boolean;
  recoveryCommand: string;
  handlers?: Partial<Record<LifecycleActionKind, LifecycleActionHandler>>;
}

export function parseLifecycleIssueSelection(token: string | undefined): LifecycleIssueSelection {
  if (isHelpToken(token)) return { kind: 'help' };
  if (!token || token === 'next') return { kind: 'next' };
  const normalized = token.startsWith('#') ? token.slice(1) : token;
  const issueNumber = Number(normalized);
  if (Number.isInteger(issueNumber) && issueNumber > 0 && String(issueNumber) === normalized) {
    return { kind: 'issue', issueNumber };
  }
  throw new Error(`Invalid issue selector "${token}". Use "next", a positive issue number, "#<number>", or help. Run \`aie start --help\` for examples.`);
}

export function getLifecycleActionMutation(kind: LifecycleActionKind): LifecycleMutation {
  if (kind === 'create-branch') return 'git';
  if (kind === 'suggest-branch-name' || kind === 'verify-current-branch' || kind.startsWith('check-')) return 'none';
  return 'github';
}

export function createLifecycleAction(input: {
  id: string;
  kind: LifecycleActionKind;
  targetType: LifecycleTargetType;
  targetId: string;
  description: string;
  preconditions?: string[];
  expectedResult: string;
  details?: JsonObject;
  status?: LifecycleActionStatus;
}): LifecycleAction {
  return {
    id: input.id,
    kind: input.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    mutation: getLifecycleActionMutation(input.kind),
    description: input.description,
    preconditions: input.preconditions ?? [],
    expectedResult: input.expectedResult,
    status: input.status ?? 'planned',
    details: input.details ?? {},
  };
}

export function summarizeLifecycleActions(actions: LifecycleAction[], recoveryCommand?: string): LifecycleActionSummary {
  const completedActions = actions.filter(action => action.status === 'completed');
  const failedActions = actions.filter(action => action.status === 'failed');
  const skippedActions = actions.filter(action => action.status === 'skipped');
  return {
    ok: failedActions.length === 0,
    plannedCount: actions.filter(action => action.status === 'planned').length,
    completedCount: completedActions.length,
    failedCount: failedActions.length,
    skippedCount: skippedActions.length,
    completedActions,
    failedActions,
    skippedActions,
    recoveryCommand: failedActions.length > 0 ? recoveryCommand : undefined,
  };
}

export function buildLifecyclePlan(input: {
  command: string;
  dryRun: boolean;
  checkOnly?: boolean;
  actions: LifecycleAction[];
  preStartPolicy?: PreStartPolicyResult;
  recoveryCommand?: string;
}): LifecyclePlan {
  const actions = input.preStartPolicy && !input.preStartPolicy.ok
    ? skipBlockedMutations(input.actions, input.preStartPolicy)
    : input.actions;
  const summary = summarizeLifecycleActions(actions, input.recoveryCommand);
  return {
    ok: summary.ok && (!input.preStartPolicy || input.preStartPolicy.ok),
    command: input.command,
    dryRun: input.dryRun,
    checkOnly: input.checkOnly ?? false,
    actions,
    summary,
    preStartPolicy: input.preStartPolicy,
  };
}

export async function executeLifecyclePlan(plan: LifecyclePlan, options: LifecycleExecutionOptions): Promise<LifecyclePlan> {
  const actions: LifecycleAction[] = [];
  let failed = false;
  for (const action of plan.actions) {
    if (action.status !== 'planned') {
      actions.push(action);
      if (action.status === 'failed') failed = true;
      continue;
    }
    if (failed) {
      actions.push(skipAction(action, 'Skipped because a previous lifecycle action failed.'));
      continue;
    }
    if ((options.dryRun || options.checkOnly) && action.mutation !== 'none') {
      actions.push(action);
      continue;
    }
    const handler = options.handlers?.[action.kind];
    if (!handler && action.mutation !== 'none') {
      const failedAction = failAction(action, 'execute lifecycle action', 'No executor was registered for this planned action.', options.recoveryCommand);
      actions.push(failedAction);
      failed = true;
      continue;
    }
    try {
      if (handler) await handler(action);
      actions.push({ ...action, status: 'completed' });
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      actions.push(failAction(action, 'execute lifecycle action', cause, options.recoveryCommand));
      failed = true;
    }
  }
  return buildLifecyclePlan({
    command: plan.command,
    dryRun: options.dryRun,
    checkOnly: options.checkOnly ?? plan.checkOnly,
    actions,
    preStartPolicy: plan.preStartPolicy,
    recoveryCommand: options.recoveryCommand,
  });
}

export function canBypassPreStartPolicyForResume(queue: Queue, issueNumber: number): boolean {
  const inProgress = queue.items.filter(item => item.effectiveStatus === 'InProgress');
  return inProgress.length === 1 && inProgress[0].issue.number === issueNumber;
}

export function formatLifecycleAction(action: LifecycleAction): string {
  const scope = action.mutation === 'none' ? 'read-only' : `mutates ${action.mutation}`;
  return `${action.status}: ${action.description} (${scope})`;
}

function skipBlockedMutations(actions: LifecycleAction[], policy: PreStartPolicyResult): LifecycleAction[] {
  const reason = `Pre-start policy blocked mutation: ${policy.blockers.join('; ')}`;
  return actions.map(action => action.mutation === 'none' ? action : skipAction(action, reason));
}

function skipAction(action: LifecycleAction, reason: string): LifecycleAction {
  return {
    ...action,
    status: 'skipped',
    failure: {
      operation: action.description,
      cause: reason,
      nextAction: 'Resolve the reported blocker, then rerun the lifecycle command with --dry-run before retrying.',
    },
  };
}

function failAction(action: LifecycleAction, operation: string, cause: string, nextAction: string): LifecycleAction {
  return {
    ...action,
    status: 'failed',
    failure: { operation, cause, nextAction },
  };
}

export function makePreStartPolicyCheck(name: PreStartPolicyCheck['name'], issueNumber: number, ok: boolean, skipped: boolean, reason: string | undefined, details: JsonObject): PreStartPolicyCheck {
  const action = createLifecycleAction({
    id: `${name}:${issueNumber}`,
    kind: name === 'worktree' ? 'check-worktree' : name === 'open-pull-requests' ? 'check-open-pull-requests' : 'check-base-branch',
    targetType: 'repository',
    targetId: 'current',
    description: getPreStartDescription(name),
    expectedResult: 'Repository state is safe for starting new issue work.',
    details,
    status: skipped ? 'skipped' : ok ? 'completed' : 'failed',
  });
  const failedAction = !ok && !skipped && reason
    ? { ...action, failure: { operation: action.description, cause: reason, nextAction: 'Resolve this repository state blocker before mutating lifecycle state.' } }
    : action;
  return { name, ok, skipped, reason, action: failedAction };
}

function getPreStartDescription(name: PreStartPolicyCheck['name']): string {
  if (name === 'worktree') return 'Check linked worktree policy';
  if (name === 'open-pull-requests') return 'Check blocking open pull requests';
  return 'Check local base branch freshness';
}

export function getPreStartNextActions(blockerCount: number, config: Config): string[] {
  if (blockerCount === 0) return [];
  return [
    'Run the lifecycle command with --dry-run after fixing the blockers.',
    `Update ${config.baseRemote}/${config.baseBranch} before starting new work when base branch freshness fails.`,
    'Merge or close blocking pull requests, or configure ignored automation authors when appropriate.',
    'Use the primary checkout instead of a linked git worktree.',
  ];
}
