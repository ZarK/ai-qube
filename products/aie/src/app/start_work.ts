import { createAction, createActionPlan, type Action } from '../core/action_plan.js';
import { selectNextWork } from '../core/queue_rules.js';
import { suggestBranchName } from '../core/branch_rules.js';
import { maybeWorkItemKeyNumber, type WorkItem } from '../core/work_item.js';
import { buildLifecyclePlan, createLifecycleAction, type LifecycleIssueSelection, type LifecyclePlan, type PreStartPolicyResult } from '../lifecycle.js';
import { actionToLifecycle, activeWorkState, applyProviderPlan, emptyLifecyclePlan, githubIssueLifecycleUnsupportedReason, loadQueueState, workItemNumber, type ActiveWorkState, type ApplyResult, type LifecycleServiceContext } from './lifecycle_common.js';
import { buildPreStartPolicy } from './pre_start_policy.js';

export interface StartServiceResult {
  ok: boolean;
  action: 'started' | 'resumed' | 'blocked' | 'empty' | 'invalid';
  reason: string;
  selectedItem: WorkItem | null;
  blockers: number[];
  activeIssueState: ActiveWorkState;
  preStartPolicy?: PreStartPolicyResult;
  branchName: string;
  plan: LifecyclePlan;
  warnings: string[];
  errors: string[];
}

function blocked(input: Omit<StartServiceResult, 'ok'>): StartServiceResult {
  return { ok: false, ...input };
}

function blockedStart(input: {
  action: StartServiceResult['action'];
  reason: string;
  selectedItem: WorkItem | null;
  activeIssueState: ActiveWorkState;
  dryRun: boolean;
  branchName?: string;
  blockers?: number[];
  warnings?: string[];
}): StartServiceResult {
  return blocked({
    action: input.action,
    reason: input.reason,
    selectedItem: input.selectedItem,
    blockers: input.blockers ?? [],
    activeIssueState: input.activeIssueState,
    branchName: input.branchName ?? '',
    plan: emptyLifecyclePlan('start', input.dryRun),
    warnings: input.warnings ?? [],
    errors: [input.reason],
  });
}

function startLifecyclePlan(input: { actions: Action[]; results: ApplyResult[]; item: WorkItem; branchName: string; preStartPolicy: PreStartPolicyResult; dryRun: boolean }): LifecyclePlan {
  const issueNumber = workItemNumber(input.item);
  const actions = [createLifecycleAction({
    id: `suggest-branch-name:${issueNumber}`,
    kind: 'suggest-branch-name',
    targetType: 'branch',
    targetId: input.branchName,
    description: `Suggest branch ${input.branchName}`,
    expectedResult: 'Branch recommendation is available before implementation.',
    details: { branchName: input.branchName },
  })];
  input.actions.forEach((action, index) => {
    if (action.kind === 'replace-status-labels') actions.push(actionToLifecycle(action, input.results[index], `replace-status-labels:${issueNumber}`, 'replace-status-labels'));
    if (action.kind === 'assign-work') actions.push(actionToLifecycle(action, input.results[index], `assign-issue:${issueNumber}`, 'assign-issue'));
    if (action.kind === 'comment-work') actions.push(actionToLifecycle(action, input.results[index], `add-comment:${issueNumber}`, 'add-comment'));
  });
  return buildLifecyclePlan({ command: 'start', dryRun: input.dryRun, preStartPolicy: input.preStartPolicy, actions, recoveryCommand: `qube aie start ${issueNumber} --dry-run` });
}

function providerStartActions(item: WorkItem, context: LifecycleServiceContext, assign: boolean, comment: boolean, resumed: boolean): Action[] {
  const actions = resumed ? [] : [...context.provider.planStart(item, context.policy).actions];
  if (context.provider.id !== 'github') return actions;
  const issueNumber = workItemNumber(item);
  if (assign && !resumed) actions.push(createAction({ id: `assign-work:${issueNumber}`, kind: 'assign-work', target: { kind: 'work-item', id: item.key.id }, mutation: 'work-provider', description: `Assign issue #${issueNumber} to the authenticated GitHub user`, expectedResult: 'The authenticated GitHub user is assigned to the issue.', details: { issueNumber } }));
  if (comment && !resumed) actions.push(createAction({ id: `comment-work:${issueNumber}`, kind: 'comment-work', target: { kind: 'work-item', id: item.key.id }, mutation: 'work-provider', description: `Add started-work comment to issue #${issueNumber}`, expectedResult: 'The issue records that work has started.', details: { issueNumber, body: `Started work on #${issueNumber}.` } }));
  return actions;
}

function blockedReason(input: { selectedIssueNumber: number; preStartPolicy: PreStartPolicyResult; plan: LifecyclePlan }): string {
  if (!input.preStartPolicy.ok) {
    const failedChecks = input.preStartPolicy.checks.filter(check => !check.ok && !check.skipped).map(check => check.action.description).join(', ') || 'pre-start repository policy';
    const cause = input.preStartPolicy.blockers.join('; ') || 'repository readiness checks did not pass';
    return `Pre-start policy blocked issue #${input.selectedIssueNumber}. Operation: verify repository readiness before starting work. Likely cause: ${cause}. Next action: fix ${failedChecks}, then rerun \`qube aie start ${input.selectedIssueNumber} --dry-run\`.`;
  }
  const failedActions = input.plan.summary.failedActions.map(item => item.failure?.cause ?? item.description).join('; ') || 'provider mutation, validation, or configuration failure';
  return `Lifecycle execution failed for issue #${input.selectedIssueNumber}. Operation: apply start lifecycle actions. Likely cause: ${failedActions}. Next action: inspect the failed action output, fix repository configuration or labels, then rerun \`qube aie start ${input.selectedIssueNumber} --dry-run\`.`;
}

function selectedWorkLabel(item: WorkItem): string {
  return item.displayId;
}

export async function runStartService(options: { selection: LifecycleIssueSelection; dryRun: boolean; assign: boolean; comment: boolean; context: LifecycleServiceContext }): Promise<StartServiceResult> {
  const { selection, dryRun, assign, comment, context } = options;
  const { workItems, queue } = await loadQueueState(context);
  const activeState = activeWorkState(queue);
  if (selection.kind === 'help') return blockedStart({ action: 'invalid', reason: 'Start help was requested instead of lifecycle mutation.', selectedItem: null, activeIssueState: activeState, dryRun, warnings: ['Use command help output for usage.'] });
  const unsupportedIssueSelection = selection.kind !== 'next' ? githubIssueLifecycleUnsupportedReason(context, 'start') : null;
  if (unsupportedIssueSelection) return blockedStart({ action: 'blocked', reason: unsupportedIssueSelection, selectedItem: null, activeIssueState: activeState, dryRun });

  let selectedItem: WorkItem | null = null;
  let action: 'started' | 'resumed' = 'started';
  let reason = '';
  let blockers: number[] = [];

  if (selection.kind === 'next') {
    const next = selectNextWork(queue);
    if (next.multipleInProgress) return blockedStart({ action: 'invalid', reason: `Multiple S-InProgress issues detected (${queue.inProgressCount}). Fix labels before starting or resuming work.`, selectedItem: null, activeIssueState: activeState, dryRun });
    if (!next.workItem) return blockedStart({ action: 'empty', reason: 'No ready issue is available and no issue is currently in progress.', selectedItem: null, activeIssueState: activeState, dryRun, warnings: queue.blockedCount > 0 ? ['Open issues remain blocked by unresolved blockers.'] : [] });
    selectedItem = next.workItem;
    action = queue.inProgressCount === 1 ? 'resumed' : 'started';
    reason = action === 'resumed' ? `Resuming the single active in-progress work item ${selectedWorkLabel(selectedItem)}.` : `Starting ready work item ${selectedWorkLabel(selectedItem)} selected by queue ordering.`;
  } else {
    selectedItem = await context.provider.getWorkItem({ providerId: context.provider.id, id: String(selection.issueNumber) });
    const branchName = suggestBranchName(selectedItem, context.policy.branch).branchName;
    if (selectedItem.state === 'closed') return blockedStart({ action: 'blocked', reason: `Issue #${selection.issueNumber} is closed and cannot be started.`, selectedItem, activeIssueState: activeState, dryRun, branchName });
    if (queue.multipleInProgress) return blockedStart({ action: 'blocked', reason: `Multiple S-InProgress issues detected (${queue.inProgressCount}). Fix labels before starting or resuming work.`, selectedItem, activeIssueState: activeState, dryRun, branchName });
    const queueItem = queue.items.find(item => item.workItem.key.id === String(selection.issueNumber));
    if (queueItem?.effectiveStatus === 'InProgress') {
      action = 'resumed';
      reason = `Resuming the active in-progress work item ${selectedWorkLabel(selectedItem)}.`;
    } else if (activeState.activeIssues.length > 0) {
      const active = activeState.activeIssues[0];
      return blockedStart({ action: 'blocked', reason: `Work item ${selectedWorkLabel(active)} is already in progress. Complete or intentionally switch work before starting ${selectedWorkLabel(selectedItem)}.`, selectedItem, activeIssueState: activeState, dryRun, branchName });
    } else {
      const openKeys = new Set(workItems.map(item => item.key.id));
      blockers = selectedItem.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null && openKeys.has(String(number)));
      if (blockers.length > 0) return blockedStart({ action: 'blocked', reason: `Issue #${selection.issueNumber} has open blockers: ${blockers.map(number => `#${number}`).join(', ')}.`, selectedItem, activeIssueState: activeState, dryRun, branchName, blockers });
      reason = `Starting requested work item ${selectedWorkLabel(selectedItem)}.`;
    }
  }

  const branchName = suggestBranchName(selectedItem, context.policy.branch).branchName;
  const capabilities = context.provider.capabilities();
  if (!capabilities.planLifecycleMutations || !capabilities.applyLifecycleMutations) {
    return blockedStart({
      action: 'blocked',
      reason: githubIssueLifecycleUnsupportedReason(context, 'start') ?? `Work provider ${context.provider.id} can read ${selectedWorkLabel(selectedItem)}, but start/resume lifecycle mutations are unsupported. Use \`qube aie queue --json\` and \`qube aie next --json\` for read-only provider inspection, or configure a provider with tested lifecycle mutations before starting work.`,
      selectedItem,
      activeIssueState: activeState,
      dryRun,
      branchName,
    });
  }
  const resumed = action === 'resumed';
  const bypassForResume = resumed && activeState.inProgressCount === 1 && activeState.activeIssues[0].key.id === selectedItem.key.id;
  const selectedIssueNumber = workItemNumber(selectedItem);
  const preStartPolicy = await buildPreStartPolicy({ config: context.config, issueNumber: selectedIssueNumber, bypassForResume, exec: context.exec, cwd: context.cwd });
  const providerActions = providerStartActions(selectedItem, context, assign, comment, resumed);
  const providerPlan = createActionPlan({ id: `${context.provider.id}:start:${selectedItem.key.id}`, purpose: `Start ${selectedItem.displayId}.`, dryRun: true, actions: providerActions });
  const results = await applyProviderPlan(context.provider, providerPlan, dryRun || !preStartPolicy.ok);
  const plan = startLifecyclePlan({ actions: providerActions, results, item: selectedItem, branchName, preStartPolicy, dryRun });
  const warnings: string[] = [];
  if (context.config.assignOnStart && !assign) warnings.push('Assignment was disabled by --no-assign.');
  if (context.config.commentOnStart && !comment) warnings.push('Started-work comment was disabled by --no-comment.');
  if (!context.config.assignOnStart) warnings.push('Assignment is disabled by repository policy.');
  if (!context.config.commentOnStart) warnings.push('Started-work comments are disabled by repository policy.');
  const errors = preStartPolicy.ok ? plan.summary.failedActions.map(item => item.failure?.cause ?? item.description) : preStartPolicy.blockers;
  return { ok: plan.ok, action: plan.ok ? action : 'blocked', reason: plan.ok ? reason : blockedReason({ selectedIssueNumber, preStartPolicy, plan }), selectedItem, blockers, activeIssueState: activeState, preStartPolicy, branchName, plan, warnings, errors };
}
