import type { Config } from '../config';
import { getDefaults, loadConfig } from '../config';
import { configToExecutorPolicy } from '../config_policy';
import type { Action, ActionFailure, ActionPlan, ActionResult } from '../core/action_plan';
import { createActionPlan } from '../core/action_plan';
import { computeWorkQueue, type WorkQueueState } from '../core/queue_rules';
import type { ExecutorPolicy } from '../core/policy';
import type { WorkItem } from '../core/work_item';
import { workItemNumber } from '../core/work_item';
import type { GhExec } from '../gh';
import { buildLifecyclePlan, createLifecycleAction, type LifecycleAction, type LifecyclePlan } from '../lifecycle';
import { createGitHubWorkProvider } from '../providers/github/github_work_provider';
import type { WorkProvider } from '../providers/work_provider';

export interface LifecycleServiceContext {
  config: Config;
  policy: ExecutorPolicy;
  provider: WorkProvider;
  exec?: GhExec;
  cwd?: string;
}

export interface QueueState {
  workItems: WorkItem[];
  queue: WorkQueueState;
}

export interface ActiveWorkState {
  inProgressCount: number;
  activeIssues: WorkItem[];
  multipleInProgress: boolean;
}

export interface ApplyResult {
  status: 'planned' | 'completed' | 'failed' | 'skipped';
  failure: ActionFailure | null;
}

export async function createLifecycleContext(options: { config?: Config; cwd?: string; exec?: GhExec; limit?: number }): Promise<LifecycleServiceContext> {
  const config = options.config ?? (await loadConfig(options.cwd)) ?? getDefaults();
  return {
    config,
    policy: configToExecutorPolicy(config),
    provider: createGitHubWorkProvider({ exec: options.exec, cwd: options.cwd, includeAssignees: false, limit: options.limit }),
    exec: options.exec,
    cwd: options.cwd,
  };
}

export async function loadQueueState(context: LifecycleServiceContext): Promise<QueueState> {
  const workItems = await context.provider.listOpenWorkItems();
  const queue = computeWorkQueue(workItems, {
    priorityLabels: context.config.priorityLabels,
    statusLabels: context.config.statusLabels,
    milestoneOrdering: context.config.milestoneOrdering,
  });
  return { workItems, queue };
}

export function activeWorkState(queue: WorkQueueState): ActiveWorkState {
  const activeIssues = queue.items.filter(item => item.effectiveStatus === 'InProgress').map(item => item.workItem);
  return { inProgressCount: activeIssues.length, activeIssues, multipleInProgress: activeIssues.length > 1 };
}

export { workItemNumber };

export async function applyProviderPlan(provider: WorkProvider, plan: ActionPlan, dryRun: boolean, checkOnly = false): Promise<ApplyResult[]> {
  if (dryRun || checkOnly) return plan.actions.map(() => ({ status: 'planned', failure: null }));
  const results: ApplyResult[] = [];
  let failed = false;
  for (const action of plan.actions) {
    if (failed) {
      results.push({
        status: 'skipped',
        failure: {
          operation: action.description,
          cause: 'Skipped because a previous lifecycle action failed.',
          nextAction: 'Resolve the reported blocker, then rerun the lifecycle command with --dry-run before retrying.',
        },
      });
      continue;
    }
    const singlePlan = createActionPlan({ id: `single:${action.id}`, purpose: action.description, dryRun: false, actions: [action] });
    const [result] = await provider.apply(singlePlan) as ActionResult[];
    results.push({ status: result.status, failure: result.failure });
    if (result.status === 'failed') failed = true;
  }
  return results;
}

export function actionToLifecycle(action: Action, result: ApplyResult, id: string, kind: LifecycleAction['kind']): LifecycleAction {
  const lifecycleAction = createLifecycleAction({
    id,
    kind,
    targetType: action.target.kind === 'work-item' ? 'issue' : action.target.kind === 'repository' ? 'repository' : 'branch',
    targetId: String(typeof action.details.issueNumber === 'number' ? action.details.issueNumber : action.target.id),
    description: action.description,
    expectedResult: action.expectedResult,
    details: action.details,
    status: result.status,
  });
  return result.failure ? { ...lifecycleAction, failure: result.failure } : lifecycleAction;
}

export function emptyLifecyclePlan(command: string, dryRun: boolean, checkOnly = false): LifecyclePlan {
  return buildLifecyclePlan({ command, dryRun, checkOnly, actions: [] });
}
