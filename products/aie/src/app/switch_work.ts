import { createAction, createActionPlan, type Action } from '../core/action_plan.js';
import { suggestBranchName } from '../core/branch_rules.js';
import { maybeWorkItemKeyNumber, type WorkItem } from '../core/work_item.js';
import { buildLifecyclePlan, createLifecycleAction, type LifecyclePlan, type PreStartPolicyResult } from '../lifecycle.js';
import { actionToLifecycle, activeWorkState, applyProviderPlan, emptyLifecyclePlan, githubIssueLifecycleUnsupportedReason, loadQueueState, workItemNumber, type ActiveWorkState, type ApplyResult, type LifecycleServiceContext } from './lifecycle_common.js';
import { buildPreStartPolicy } from './pre_start_policy.js';

export interface SwitchServiceResult {
  ok: boolean;
  action: 'switched' | 'resumed' | 'blocked' | 'invalid';
  reason: string;
  sourceItem: WorkItem | null;
  targetItem: WorkItem | null;
  blockers: number[];
  activeIssueState: ActiveWorkState;
  preStartPolicy?: PreStartPolicyResult;
  branchName: string;
  plan: LifecyclePlan;
  warnings: string[];
  errors: string[];
}

function blockedSwitch(input: Omit<SwitchServiceResult, 'ok'>): SwitchServiceResult {
  return { ok: false, ...input };
}

function emptyBlocked(input: { action: SwitchServiceResult['action']; reason: string; sourceItem: WorkItem | null; targetItem: WorkItem | null; activeIssueState: ActiveWorkState; dryRun: boolean; branchName: string; blockers?: number[] }): SwitchServiceResult {
  return blockedSwitch({ action: input.action, reason: input.reason, sourceItem: input.sourceItem, targetItem: input.targetItem, blockers: input.blockers ?? [], activeIssueState: input.activeIssueState, branchName: input.branchName, plan: emptyLifecyclePlan('switch', input.dryRun), warnings: [], errors: [input.reason] });
}

function switchPlan(input: { actions: Action[]; results: ApplyResult[]; pauseCount: number; source: WorkItem; target: WorkItem; branchName: string; preStartPolicy: PreStartPolicyResult; dryRun: boolean }): LifecyclePlan {
  const sourceNumber = workItemNumber(input.source);
  const targetNumber = workItemNumber(input.target);
  const actions = [createLifecycleAction({ id: `suggest-branch-name:${targetNumber}`, kind: 'suggest-branch-name', targetType: 'branch', targetId: input.branchName, description: `Suggest branch ${input.branchName}`, expectedResult: 'Branch recommendation is available before implementation.', details: { branchName: input.branchName } })];
  input.actions.forEach((action, index) => {
    if (index < input.pauseCount && action.kind === 'replace-status-labels') actions.push(actionToLifecycle(action, input.results[index], `pause-source:${sourceNumber}`, 'replace-status-labels'));
    if (index >= input.pauseCount && action.kind === 'replace-status-labels') actions.push(actionToLifecycle(action, input.results[index], `start-target:${targetNumber}`, 'replace-status-labels'));
    if (action.kind === 'assign-work') actions.push(actionToLifecycle(action, input.results[index], `assign-issue:${targetNumber}`, 'assign-issue'));
    if (action.kind === 'comment-work') actions.push(actionToLifecycle(action, input.results[index], `add-comment:${targetNumber}`, 'add-comment'));
  });
  return buildLifecyclePlan({ command: 'switch', dryRun: input.dryRun, preStartPolicy: input.preStartPolicy, actions, recoveryCommand: `aie switch ${targetNumber} --from ${sourceNumber} --dry-run` });
}

export async function runSwitchService(options: { targetIssueNumber: number; fromIssueNumber?: number; dryRun: boolean; assign: boolean; comment: boolean; context: LifecycleServiceContext }): Promise<SwitchServiceResult> {
  const { targetIssueNumber, fromIssueNumber, dryRun, assign, comment, context } = options;
  const { workItems, queue } = await loadQueueState(context);
  const activeState = activeWorkState(queue);
  const unsupportedProvider = githubIssueLifecycleUnsupportedReason(context, 'switch');
  if (unsupportedProvider) return emptyBlocked({ action: 'blocked', reason: unsupportedProvider, sourceItem: null, targetItem: null, activeIssueState: activeState, dryRun, branchName: '' });
  const target = await context.provider.getWorkItem({ providerId: context.provider.id, id: String(targetIssueNumber) });
  const branchName = suggestBranchName(target, context.policy.branch).branchName;
  const active = queue.items.filter(item => item.effectiveStatus === 'InProgress');
  let source: WorkItem | null = null;

  if (fromIssueNumber === undefined) {
    if (active.length === 0) return emptyBlocked({ action: 'invalid', reason: 'No S-InProgress source issue was detected. Use `aie switch <issue> --from <source>` when the source issue is not unambiguous.', sourceItem: null, targetItem: target, activeIssueState: activeState, dryRun, branchName });
    if (active.length > 1) return emptyBlocked({ action: 'invalid', reason: `Multiple S-InProgress issues detected (${active.length}). Use --from to choose the source issue and ensure no unrelated issue remains active.`, sourceItem: null, targetItem: target, activeIssueState: activeState, dryRun, branchName });
    source = active[0].workItem;
  } else {
    source = await context.provider.getWorkItem({ providerId: context.provider.id, id: String(fromIssueNumber) });
    const sourceQueueItem = queue.items.find(item => item.workItem.key.id === String(fromIssueNumber));
    if (!sourceQueueItem || sourceQueueItem.effectiveStatus !== 'InProgress') return emptyBlocked({ action: 'invalid', reason: `Issue #${fromIssueNumber} is not S-InProgress and cannot be used as the switch source.`, sourceItem: source, targetItem: target, activeIssueState: activeState, dryRun, branchName });
  }

  const sourceNumber = workItemNumber(source);
  if (sourceNumber === targetIssueNumber) return emptyBlocked({ action: 'invalid', reason: `Issue #${targetIssueNumber} is already the switch source. Choose a different target issue.`, sourceItem: source, targetItem: target, activeIssueState: activeState, dryRun, branchName });
  if (source.state === 'closed') return emptyBlocked({ action: 'invalid', reason: `Issue #${sourceNumber} is closed and cannot be paused as the switch source.`, sourceItem: source, targetItem: target, activeIssueState: activeState, dryRun, branchName });
  if (target.state === 'closed') return emptyBlocked({ action: 'blocked', reason: `Issue #${targetIssueNumber} is closed and cannot be started.`, sourceItem: source, targetItem: target, activeIssueState: activeState, dryRun, branchName });

  const remainingActive = active.filter(item => workItemNumber(item.workItem) !== sourceNumber);
  const targetAlreadyActive = remainingActive.length === 1 && workItemNumber(remainingActive[0].workItem) === targetIssueNumber;
  if (remainingActive.length > 0 && !targetAlreadyActive) {
    const reason = `Switch would leave unrelated S-InProgress issue(s): ${remainingActive.map(item => `#${workItemNumber(item.workItem)}`).join(', ')}. Fix labels before switching work.`;
    return emptyBlocked({ action: 'invalid', reason, sourceItem: source, targetItem: target, activeIssueState: activeState, dryRun, branchName });
  }

  const openKeys = new Set(workItems.map(item => item.key.id));
  const blockers = target.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null && openKeys.has(String(number)));
  if (!targetAlreadyActive && blockers.length > 0) return emptyBlocked({ action: 'blocked', reason: `Issue #${targetIssueNumber} has open blockers: ${blockers.map(number => `#${number}`).join(', ')}.`, sourceItem: source, targetItem: target, activeIssueState: activeState, dryRun, branchName, blockers });

  const preStartPolicy = await buildPreStartPolicy({ config: context.config, issueNumber: targetIssueNumber, bypassForResume: targetAlreadyActive, exec: context.exec, cwd: context.cwd });
  const pauseActions = context.provider.planPause(source, workItems, context.policy).actions;
  const startActions = targetAlreadyActive ? [] : context.provider.planStart(target, context.policy).actions;
  const actions: Action[] = [...pauseActions, ...startActions];
  if (context.provider.id === 'github' && assign && !targetAlreadyActive) actions.push(createAction({ id: `assign-work:${targetIssueNumber}`, kind: 'assign-work', target: { kind: 'work-item', id: target.key.id }, mutation: 'work-provider', description: `Assign issue #${targetIssueNumber} to the authenticated GitHub user`, expectedResult: 'The authenticated GitHub user is assigned to the issue.', details: { issueNumber: targetIssueNumber } }));
  if (context.provider.id === 'github' && comment && !targetAlreadyActive) actions.push(createAction({ id: `comment-work:${targetIssueNumber}`, kind: 'comment-work', target: { kind: 'work-item', id: target.key.id }, mutation: 'work-provider', description: `Add switched-work comment to issue #${targetIssueNumber}`, expectedResult: 'The issue records that work switched to it.', details: { issueNumber: targetIssueNumber, body: `Switched work from #${sourceNumber} to #${targetIssueNumber}.` } }));
  const providerPlan = createActionPlan({ id: `${context.provider.id}:switch:${source.key.id}:${target.key.id}`, purpose: `Switch from ${source.displayId} to ${target.displayId}.`, dryRun: true, actions });
  const results = await applyProviderPlan(context.provider, providerPlan, dryRun || !preStartPolicy.ok);
  const plan = switchPlan({ actions, results, pauseCount: pauseActions.length, source, target, branchName, preStartPolicy, dryRun });
  const warnings: string[] = [];
  if (context.config.assignOnStart && !assign) warnings.push('Assignment was disabled by --no-assign.');
  if (context.config.commentOnStart && !comment) warnings.push('Switched-work comment was disabled by --no-comment.');
  if (!context.config.assignOnStart) warnings.push('Assignment is disabled by repository policy.');
  if (!context.config.commentOnStart) warnings.push('Switched-work comments are disabled by repository policy.');
  const errors = preStartPolicy.ok ? plan.summary.failedActions.map(item => item.failure?.cause ?? item.description) : preStartPolicy.blockers;
  const successReason = `Switching from #${sourceNumber} to #${targetIssueNumber}.`;
  return { ok: plan.ok, action: plan.ok ? targetAlreadyActive ? 'resumed' : 'switched' : 'blocked', reason: plan.ok ? successReason : preStartPolicy.ok ? `Lifecycle execution failed while switching to issue #${targetIssueNumber}.` : `Pre-start policy blocked switch to issue #${targetIssueNumber}.`, sourceItem: source, targetItem: target, blockers, activeIssueState: activeState, preStartPolicy, branchName, plan, warnings, errors };
}
