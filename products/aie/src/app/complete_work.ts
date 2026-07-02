import { buildLifecyclePlan, type LifecyclePlan } from '../lifecycle.js';
import { maybeWorkItemKeyNumber, parseWorkChecklistItems, workItemNumber, type WorkItem } from '../core/work_item.js';
import type { Action } from '../core/action_plan.js';
import { getRepositoryIdentity, listMilestones } from '../repo/index.js';
import { actionToLifecycle, applyProviderPlan, githubIssueLifecycleUnsupportedReason, type ApplyResult, type LifecycleServiceContext } from './lifecycle_common.js';

export interface CompletionChecklistItem { text: string; checked: boolean }
export interface CompletionChecklist { total: number; checked: number; unchecked: number; items: CompletionChecklistItem[] }
export interface CompletionMilestoneContext { number: number; title: string; state: string; dueOn: string | null; openIssues: number | null; closedIssues: number | null; remainingOpenIssues: number | null }
export interface CompletionState { alreadyClosed: boolean; willClose: boolean; statusLabelsToRemove: string[] }
export interface DependentRefreshServiceResult { item: WorkItem; status: 'unblocked' | 'still-blocked' | 'unchanged' | 'skipped'; openBlockers: number[]; addLabels: string[]; removeLabels: string[]; actionId: string | null; reason: string }

export interface CompleteServiceResult {
  ok: boolean;
  action: 'completed' | 'checked' | 'planned' | 'blocked' | 'failed';
  reason: string;
  item: WorkItem;
  checklist: CompletionChecklist;
  completion: CompletionState;
  milestoneContext: CompletionMilestoneContext | null;
  dependentRefresh: { dependents: DependentRefreshServiceResult[]; unblocked: DependentRefreshServiceResult[]; stillBlocked: DependentRefreshServiceResult[]; skipped: DependentRefreshServiceResult[] };
  plan: LifecyclePlan;
  nextCommand: string;
  warnings: string[];
  errors: string[];
}

function checklist(body: string): CompletionChecklist {
  const items: CompletionChecklistItem[] = parseWorkChecklistItems(body);
  const checked = items.filter(item => item.checked).length;
  return { total: items.length, checked, unchecked: items.length - checked, items };
}

function statusLabelsToRemove(item: WorkItem, context: LifecycleServiceContext): string[] {
  return context.config.statusLabels.filter(label => item.tags.includes(label));
}

async function milestoneContext(item: WorkItem, context: LifecycleServiceContext, warnings: string[]): Promise<CompletionMilestoneContext | null> {
  if (!item.project) return null;
  const fallback = { number: Number(item.project.id), title: item.project.title, state: item.project.state.toUpperCase(), dueOn: item.project.dueOn, openIssues: null, closedIssues: null, remainingOpenIssues: null };
  if (context.provider.id !== 'github') return fallback;
  try {
    const repository = await getRepositoryIdentity({ exec: context.exec, cwd: context.cwd });
    const milestones = await listMilestones(repository, { exec: context.exec, cwd: context.cwd });
    const match = milestones.find(candidate => candidate.number === fallback.number);
    if (!match) return fallback;
    return { ...match, remainingOpenIssues: item.state === 'open' ? Math.max(match.openIssues - 1, 0) : match.openIssues };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push(`Milestone context unavailable: ${detail}`);
    return fallback;
  }
}

function completePlan(actions: Action[], results: ApplyResult[], item: WorkItem, dryRun: boolean, checkOnly: boolean): LifecyclePlan {
  const issueNumber = workItemNumber(item);
  const lifecycleActions = actions.map((action, index) => {
    if (action.kind === 'close-work') return actionToLifecycle(action, results[index], `close-issue:${issueNumber}`, 'close-issue');
    const targetNumber = typeof action.details.issueNumber === 'number' ? action.details.issueNumber : Number(action.target.id);
    return actionToLifecycle(action, results[index], targetNumber === issueNumber ? `complete-status:${issueNumber}` : `refresh-dependent:${targetNumber}`, targetNumber === issueNumber ? 'replace-status-labels' : 'refresh-dependent-status');
  });
  return buildLifecyclePlan({ command: 'complete', dryRun, checkOnly, actions: lifecycleActions, recoveryCommand: `aie complete ${issueNumber} --dry-run` });
}

function directDependents(openItems: WorkItem[], item: WorkItem): WorkItem[] {
  return openItems.filter(candidate => candidate.key.id !== item.key.id && candidate.blockers.some(blocker => blocker.providerId === item.key.providerId && blocker.id === item.key.id));
}

function refreshResult(dependent: WorkItem, action: Action | undefined, allOpenItems: WorkItem[], completed: WorkItem): DependentRefreshServiceResult {
  const futureOpenKeys = new Set(allOpenItems.filter(item => item.key.id !== completed.key.id).map(item => item.key.id));
  const openBlockers = dependent.blockers.map(maybeWorkItemKeyNumber).filter((number): number is number => number !== null && futureOpenKeys.has(String(number)));
  if (dependent.tags.includes('S-InProgress')) return { item: dependent, status: 'skipped', openBlockers, addLabels: [], removeLabels: [], actionId: null, reason: 'Dependent issue is S-InProgress and lifecycle refresh will not change active work.' };
  const addLabels = Array.isArray(action?.details.addLabels) ? action.details.addLabels.filter((label): label is string => typeof label === 'string') : [];
  const removeLabels = Array.isArray(action?.details.removeLabels) ? action.details.removeLabels.filter((label): label is string => typeof label === 'string') : [];
  const status = openBlockers.length > 0 ? 'still-blocked' : addLabels.length > 0 || removeLabels.length > 0 ? 'unblocked' : 'unchanged';
  const reason = openBlockers.length > 0 ? `Dependent still has open blocker(s): ${openBlockers.map(number => `#${number}`).join(', ')}.` : 'All open blockers are resolved after completion.';
  return { item: dependent, status, openBlockers, addLabels, removeLabels, actionId: action ? `refresh-dependent:${workItemNumber(dependent)}` : null, reason };
}

function summarize(dependents: DependentRefreshServiceResult[]): CompleteServiceResult['dependentRefresh'] {
  return { dependents, unblocked: dependents.filter(item => item.status === 'unblocked'), stillBlocked: dependents.filter(item => item.status === 'still-blocked'), skipped: dependents.filter(item => item.status === 'skipped') };
}

function blockedPlan(actions: Action[], item: WorkItem, dryRun: boolean, checkOnly: boolean, reason: string): LifecyclePlan {
  const skipped = actions.map(action => ({
    status: 'skipped' as const,
    failure: {
      operation: action.description,
      cause: reason,
      nextAction: 'Resolve the reported blocker, then rerun `aie complete <issue> --check-only`.',
    },
  }));
  return completePlan(actions, skipped, item, dryRun, checkOnly);
}

function blocked(item: WorkItem, state: CompletionState, list: CompletionChecklist, milestone: CompletionMilestoneContext | null, dependents: DependentRefreshServiceResult[], plan: LifecyclePlan, reason: string, warnings: string[]): CompleteServiceResult {
  return { ok: false, action: 'blocked', reason, item, checklist: list, completion: state, milestoneContext: milestone, dependentRefresh: summarize(dependents), plan, nextCommand: 'Resolve the reported blocker, then rerun `aie complete <issue> --check-only`.', warnings, errors: [reason] };
}

export async function runCompleteService(options: { issueNumber: number; dryRun: boolean; checkOnly: boolean; force: boolean; context: LifecycleServiceContext }): Promise<CompleteServiceResult> {
  const { issueNumber, dryRun, checkOnly, force, context } = options;
  const unsupportedProvider = githubIssueLifecycleUnsupportedReason(context, 'complete');
  if (unsupportedProvider) throw new Error(unsupportedProvider);
  const item = await context.provider.getWorkItem({ providerId: context.provider.id, id: String(issueNumber) });
  const list = checklist(item.body);
  const allOpenItems = await context.provider.listOpenWorkItems();
  const dependents = directDependents(allOpenItems, item).sort((left, right) => workItemNumber(left) - workItemNumber(right));
  const warnings: string[] = [];
  const milestone = await milestoneContext(item, context, warnings);
  const completion = { alreadyClosed: item.state === 'closed', willClose: item.state === 'open', statusLabelsToRemove: statusLabelsToRemove(item, context) };
  const providerPlan = context.provider.planComplete(item, allOpenItems.filter(candidate => candidate.key.id !== item.key.id), context.policy);
  const actionByIssue = new Map(providerPlan.actions.filter(action => action.kind === 'replace-status-labels').map(action => [String(action.details.issueNumber), action]));
  const dependentRefresh = dependents.map(dependent => refreshResult(dependent, actionByIssue.get(String(workItemNumber(dependent))), allOpenItems, item));

  if (item.state === 'open' && !item.tags.includes('S-InProgress')) {
    const reason = `Issue #${issueNumber} is open but not S-InProgress. Complete only the active issue, or let already-closed issues refresh dependents.`;
    return blocked(item, completion, list, milestone, dependentRefresh, blockedPlan([...providerPlan.actions], item, dryRun, checkOnly, reason), reason, warnings);
  }
  if (list.unchecked > 0) {
    const reason = force
      ? `Issue #${issueNumber} has ${list.unchecked} unchecked checklist item(s); --force cannot bypass acceptance criteria in autonomous mode.`
      : `Issue #${issueNumber} has ${list.unchecked} unchecked checklist item(s).`;
    return blocked(item, completion, list, milestone, dependentRefresh, blockedPlan([...providerPlan.actions], item, dryRun, checkOnly, reason), reason, warnings);
  }

  const results = await applyProviderPlan(context.provider, providerPlan, dryRun, checkOnly);
  const plan = completePlan([...providerPlan.actions], results, item, dryRun, checkOnly);
  const errors = plan.summary.failedActions.map(action => action.failure?.cause ?? action.description);
  const ok = plan.ok;
  const action: CompleteServiceResult['action'] = ok ? checkOnly ? 'checked' : dryRun ? 'planned' : 'completed' : 'failed';
  const mode = checkOnly ? 'verified completion readiness for' : dryRun ? 'planned completion for' : 'completed';
  return { ok, action, reason: ok ? `Successfully ${mode} issue #${issueNumber}.` : `Lifecycle execution failed while completing issue #${issueNumber}.`, item, checklist: list, completion, milestoneContext: milestone, dependentRefresh: summarize(dependentRefresh), plan, nextCommand: ok ? 'Run `aie next --json` or `aie queue` to choose the next issue.' : 'Resolve the reported blocker, then rerun `aie complete <issue> --check-only`.', warnings, errors: ok ? [] : errors };
}
