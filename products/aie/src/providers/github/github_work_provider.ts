import { createAction, createActionPlan, type Action, type ActionPlan, type ActionResult } from '../../core/action_plan.js';
import type { ExecutorPolicy } from '../../core/policy.js';
import type { WorkItem, WorkItemKey } from '../../core/work_item.js';
import { buildWorkDependencyGraph, createWorkStatusSyncActionPlan, getOpenBlockerKeys, getOpenWorkItemKeys, workItemIsInProgress, type WorkDependencyGraph, type WorkQueuePolicy } from '../../core/queue_rules.js';
import { getIssue, listOpenIssues } from '../../github.js';
import { GhExec, GhExecutionError, GhRunResult, parseGhJson, runGh } from '../../gh.js';
import type { WorkProvider, WorkProviderCapabilities } from '../work_provider.js';
import { attachBlockedBy, githubIssueNumber, githubIssueToWorkItem } from './github_work_codec.js';

interface LoginResponse {
  login: string;
}

interface GitHubWorkProviderOptions {
  exec?: GhExec;
  cwd?: string;
  limit?: number;
  includeAssignees?: boolean;
}

function isLoginResponse(value: unknown): value is LoginResponse {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).login === 'string' && (value as Record<string, unknown>).login !== '';
}

function getStringArray(details: Record<string, unknown>, key: string): string[] {
  const value = details[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}

function getString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' ? value : null;
}

function ensureGhSuccess(operation: string, result: GhRunResult): void {
  if (result.exitCode !== 0) {
    throw new GhExecutionError(operation, result.exitCode, result.stderr || result.stdout);
  }
}

function statusLabels(item: WorkItem, policy: ExecutorPolicy): string[] {
  const configured = new Set(policy.labels.statuses.map(label => label.name));
  return item.tags.filter(label => configured.has(label));
}

function policyToWorkQueuePolicy(policy: ExecutorPolicy): WorkQueuePolicy {
  return {
    priorityLabels: policy.labels.priorities.map(label => label.name),
    statusLabels: policy.labels.statuses.map(label => label.name),
    milestoneOrdering: policy.milestoneOrdering,
  };
}

function sameWorkItem(left: WorkItem, right: WorkItem): boolean {
  return left.key.providerId === right.key.providerId && left.key.id === right.key.id;
}

function itemBlocksOpenWork(item: WorkItem, openItems: WorkItem[]): boolean {
  return itemBlocksOpenWorkFromGraph(item, buildWorkDependencyGraph(openItems));
}

function itemBlocksOpenWorkFromGraph(item: WorkItem, graph: WorkDependencyGraph): boolean {
  const node = graph.nodes.find(candidate => sameWorkItem(candidate.workItem, item));
  return node?.blocksOpenWork ?? false;
}

function makeStatusAction(item: WorkItem, addLabels: string[], removeLabels: string[], purpose: string): Action | null {
  const uniqueAdd = [...new Set(addLabels)];
  const uniqueRemove = [...new Set(removeLabels)];
  if (uniqueAdd.length === 0 && uniqueRemove.length === 0) return null;
  const issueNumber = githubIssueNumber(item);
  return createAction({
    id: `replace-status-labels:${issueNumber}`,
    kind: 'replace-status-labels',
    target: { kind: 'work-item', id: item.key.id },
    mutation: 'work-provider',
    description: purpose,
    expectedResult: `Issue #${issueNumber} has provider labels synchronized with Executor work state.`,
    details: { issueNumber, addLabels: uniqueAdd, removeLabels: uniqueRemove },
  });
}

function actionResult(action: Action, status: ActionResult['status'], failure: ActionResult['failure'] = null): ActionResult {
  return { actionId: action.id, status, failure, details: action.details };
}

export class GitHubWorkProvider implements WorkProvider {
  readonly id = 'github' as const;

  constructor(private readonly options: GitHubWorkProviderOptions = {}) {}

  private includeAssignees(): boolean {
    return this.options.includeAssignees ?? true;
  }

  capabilities(): WorkProviderCapabilities {
    return {
      listOpenWork: true,
      loadWork: true,
      planStatusSync: true,
      planLifecycleMutations: true,
      applyLifecycleMutations: true,
    };
  }

  async listOpenWorkItems(): Promise<WorkItem[]> {
    const issues = await listOpenIssues({ ...this.options, includeAssignees: this.includeAssignees() });
    return attachBlockedBy(issues.map(githubIssueToWorkItem));
  }

  async getWorkItem(key: WorkItemKey): Promise<WorkItem> {
    if (key.providerId !== this.id) {
      throw new Error(`load GitHub work item failed: providerId ${key.providerId} is unsupported. Use a github work item key.`);
    }
    const issueNumber = Number(key.id);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`load GitHub work item failed: key id ${key.id} is not a positive issue number. Use a numeric GitHub issue id.`);
    }
    return githubIssueToWorkItem(await getIssue(issueNumber, { ...this.options, includeAssignees: this.includeAssignees() }));
  }

  planStatusSync(items: WorkItem[], policy: ExecutorPolicy): ActionPlan {
    const corePlan = createWorkStatusSyncActionPlan(items, policyToWorkQueuePolicy(policy));
    const actions = corePlan.actions.map((action): Action => {
      const item = items.find(candidate => candidate.key.providerId === action.details.providerId && candidate.key.id === action.target.id);
      if (!item) return action;
      return createAction({
        id: `replace-status-labels:${githubIssueNumber(item)}`,
        kind: action.kind,
        target: action.target,
        mutation: action.mutation,
        description: action.description,
        expectedResult: `Issue #${githubIssueNumber(item)} has provider labels synchronized with Executor work state.`,
        preconditions: action.preconditions,
        status: action.status,
        details: { ...action.details, issueNumber: githubIssueNumber(item) },
        failure: action.failure,
      });
    });
    return createActionPlan({ id: 'github:status-sync', purpose: 'Synchronize GitHub issue status labels from provider-neutral work state.', dryRun: true, actions });
  }

  planStart(item: WorkItem, policy: ExecutorPolicy): ActionPlan {
    const removeLabels = statusLabels(item, policy).filter(label => label !== 'S-InProgress' && label !== 'S-Blocking');
    const addLabels = item.tags.includes('S-InProgress') ? [] : ['S-InProgress'];
    const action = makeStatusAction(item, addLabels, removeLabels, `Start ${item.displayId}`);
    return createActionPlan({ id: `github:start:${item.key.id}`, purpose: `Start ${item.displayId}.`, dryRun: true, actions: action ? [action] : [] });
  }

  planPause(item: WorkItem, openItems: WorkItem[], policy: ExecutorPolicy): ActionPlan {
    const openKeys = getOpenWorkItemKeys(openItems);
    const addLabels: string[] = [];
    const removeLabels: string[] = [];
    if (item.tags.includes('S-InProgress')) removeLabels.push('S-InProgress');
    if (getOpenBlockerKeys(item, openKeys).length > 0) addLabels.push('S-Blocked');
    else addLabels.push('S-Ready');
    for (const label of statusLabels(item, policy)) {
      if (label !== 'S-Blocking') removeLabels.push(label);
    }
    const blocksWork = itemBlocksOpenWork(item, openItems);
    if (blocksWork && !item.tags.includes('S-Blocking')) addLabels.push('S-Blocking');
    if (!blocksWork && item.tags.includes('S-Blocking')) removeLabels.push('S-Blocking');
    const action = makeStatusAction(item, addLabels, removeLabels, `Pause ${item.displayId}`);
    return createActionPlan({ id: `github:pause:${item.key.id}`, purpose: `Pause ${item.displayId}.`, dryRun: true, actions: action ? [action] : [] });
  }

  planComplete(item: WorkItem, dependents: WorkItem[], policy: ExecutorPolicy): ActionPlan {
    const actions: Action[] = [];
    const removeLabels = statusLabels(item, policy);
    const cleanup = makeStatusAction(item, [], removeLabels, `Remove lifecycle status labels from ${item.displayId}`);
    if (cleanup) actions.push(cleanup);
    const issueNumber = githubIssueNumber(item);
    if (item.state === 'open') {
      actions.push(createAction({
        id: `close-work:${issueNumber}`,
        kind: 'close-work',
        target: { kind: 'work-item', id: item.key.id },
        mutation: 'work-provider',
        description: `Close ${item.displayId}`,
        expectedResult: `Issue #${issueNumber} is closed as completed.`,
        details: { issueNumber, reason: 'completed' },
      }));
    }
    const openAfterCompletion = dependents.filter(dependent => dependent.state === 'open' && dependent.key.id !== item.key.id);
    const openKeys = getOpenWorkItemKeys(openAfterCompletion);
    const graphAfterCompletion = buildWorkDependencyGraph(openAfterCompletion);
    const directDependents = openAfterCompletion.filter(dependent => dependent.blockers.some(blocker => blocker.providerId === item.key.providerId && blocker.id === item.key.id));
    for (const dependent of directDependents) {
      if (workItemIsInProgress(dependent, policyToWorkQueuePolicy(policy))) continue;
      const addLabels: string[] = [];
      const removeLabels: string[] = [];
      if (getOpenBlockerKeys(dependent, openKeys).length > 0) {
        if (!dependent.tags.includes('S-Blocked')) addLabels.push('S-Blocked');
        if (dependent.tags.includes('S-Ready')) removeLabels.push('S-Ready');
      } else {
        if (!dependent.tags.includes('S-Ready')) addLabels.push('S-Ready');
        if (dependent.tags.includes('S-Blocked')) removeLabels.push('S-Blocked');
      }
      const dependentBlocksWork = itemBlocksOpenWorkFromGraph(dependent, graphAfterCompletion);
      if (dependentBlocksWork && !dependent.tags.includes('S-Blocking')) addLabels.push('S-Blocking');
      if (!dependentBlocksWork && dependent.tags.includes('S-Blocking')) removeLabels.push('S-Blocking');
      for (const label of statusLabels(dependent, policy)) {
        if (label !== 'S-Ready' && label !== 'S-Blocked' && label !== 'S-Blocking') removeLabels.push(label);
      }
      const action = makeStatusAction(dependent, addLabels, removeLabels, `Refresh dependent status for ${dependent.displayId}`);
      if (action) actions.push(action);
    }
    return createActionPlan({ id: `github:complete:${item.key.id}`, purpose: `Complete ${item.displayId}.`, dryRun: true, actions });
  }

  async apply(plan: ActionPlan): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of plan.actions) {
      try {
        await this.applyAction(action);
        results.push(actionResult(action, 'completed'));
      } catch (error: unknown) {
        const cause = error instanceof Error ? error.message : String(error);
        results.push(actionResult(action, 'failed', {
          operation: action.description,
          cause,
          nextAction: 'Verify GitHub permissions, repository labels, and gh authentication, then rerun with --dry-run before retrying.',
        }));
      }
    }
    return results;
  }

  private async applyAction(action: Action): Promise<void> {
    const issueNumber = String(getString(action.details, 'issueNumber') ?? action.target.id);
    if (action.kind === 'replace-status-labels' || action.kind === 'sync-work-status' || action.kind === 'start-work' || action.kind === 'pause-work') {
      const addLabels = getStringArray(action.details, 'addLabels');
      const removeLabels = getStringArray(action.details, 'removeLabels');
      const args = ['issue', 'edit', issueNumber];
      if (addLabels.length > 0) args.push('--add-label', addLabels.join(','));
      if (removeLabels.length > 0) args.push('--remove-label', removeLabels.join(','));
      ensureGhSuccess(`gh ${args.join(' ')}`, await runGh(args, this.options));
      return;
    }
    if (action.kind === 'assign-work') {
      const login = await this.currentLogin();
      const args = ['issue', 'edit', issueNumber, '--add-assignee', login];
      ensureGhSuccess(`gh ${args.join(' ')}`, await runGh(args, this.options));
      return;
    }
    if (action.kind === 'comment-work') {
      const body = getString(action.details, 'body') ?? `Updated work on #${issueNumber}.`;
      const args = ['issue', 'comment', issueNumber, '--body', body];
      ensureGhSuccess(`gh issue comment ${issueNumber}`, await runGh(args, this.options));
      return;
    }
    if (action.kind === 'close-work') {
      ensureGhSuccess(`gh issue close ${issueNumber}`, await runGh(['issue', 'close', issueNumber, '--reason', 'completed'], this.options));
      return;
    }
    throw new Error(`apply GitHub work action failed: ${action.kind} is not supported by the GitHub work provider. Use a work-provider action kind.`);
  }

  private async currentLogin(): Promise<string> {
    const result = await runGh(['api', 'user'], this.options);
    ensureGhSuccess('gh api user', result);
    return parseGhJson<LoginResponse>(result.stdout, 'gh api user', isLoginResponse).login;
  }
}

export function createGitHubWorkProvider(options: GitHubWorkProviderOptions = {}): GitHubWorkProvider {
  return new GitHubWorkProvider(options);
}
