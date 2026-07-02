import type { Config } from '../config/index.js';
import { getDefaults, loadConfig } from '../config/index.js';
import { configToExecutorPolicy } from '../config_policy.js';
import type { Action, ActionFailure, ActionPlan, ActionResult } from '../core/action_plan.js';
import { createActionPlan } from '../core/action_plan.js';
import { computeWorkQueue, type WorkQueueState } from '../core/queue_rules.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { WorkItem } from '../core/work_item.js';
import { workItemNumber } from '../core/work_item.js';
import type { GhExec } from '../gh.js';
import { buildLifecyclePlan, createLifecycleAction, type LifecycleAction, type LifecyclePlan } from '../lifecycle.js';
import { createWorkProvider } from '../providers/work_provider_adapters.js';
import type { WorkProviderAdapterOptions } from '../providers/work_provider_adapters.js';
import type { WorkProvider } from '../providers/work_provider.js';

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
  const provider = await createWorkProvider(config.providers.work.kind, workProviderOptions(config, options));
  return {
    config,
    policy: configToExecutorPolicy(config),
    provider,
    exec: options.exec,
    cwd: options.cwd,
  };
}

export function workProviderOptions(config: Config, options: { cwd?: string; exec?: GhExec; limit?: number }): WorkProviderAdapterOptions {
  const jira = config.providers.work.kind === 'jira' ? config.providers.work.jira : undefined;
  return {
    exec: options.exec,
    cwd: options.cwd,
    limit: options.limit,
    ...(jira?.projectKey ? { projectKey: jira.projectKey } : {}),
    ...(jira?.jql ? { jql: jira.jql } : {}),
    ...(jira?.requestTimeoutMs ? { requestTimeoutMs: jira.requestTimeoutMs } : {}),
    ...(jira?.workflowSchema ? { workflowSchema: jira.workflowSchema } : {}),
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

export function githubIssueLifecycleUnsupportedReason(context: LifecycleServiceContext, command: string): string | null {
  if (context.provider.id === 'github') return null;
  return `Work provider ${context.provider.id} can be inspected through read-only queue commands, but \`qube aie ${command}\` uses GitHub issue-number lifecycle semantics and is unsupported for provider-native work item keys. Use \`qube aie queue --json\` or \`qube aie next --json\` to inspect configured ${context.provider.id} work, or configure providers.work.kind=github before running lifecycle mutation commands.`;
}

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
