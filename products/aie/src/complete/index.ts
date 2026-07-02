import { getDefaults, loadConfig, type Config } from '../config/index.js';
import type { GhExec } from '@tjalve/qube-adapter-github';
import { createLifecycleContext } from '../app/lifecycle_services.js';
import { runCompleteService, type CompletionChecklist, type CompletionChecklistItem, type CompletionMilestoneContext, type CompletionState } from '../app/complete_work.js';
import type { StartIssueSummary } from '../start/index.js';
import type { LifecyclePlan } from '../lifecycle.js';
import { workItemKeyNumber } from '../core/work_item.js';

export type CompleteAction = 'completed' | 'checked' | 'planned' | 'blocked' | 'failed';
export type { CompletionChecklistItem, CompletionChecklist, CompletionMilestoneContext, CompletionState };

export interface DependentRefreshResult {
  issue: StartIssueSummary;
  status: 'unblocked' | 'still-blocked' | 'unchanged' | 'skipped';
  openBlockers: number[];
  addLabels: string[];
  removeLabels: string[];
  actionId: string | null;
  reason: string;
}

export interface CompleteResult {
  ok: boolean;
  command: 'complete';
  dryRun: boolean;
  checkOnly: boolean;
  forced: boolean;
  action: CompleteAction;
  reason: string;
  issue: StartIssueSummary;
  checklist: CompletionChecklist;
  completion: CompletionState;
  milestoneContext: CompletionMilestoneContext | null;
  dependentRefresh: { dependents: DependentRefreshResult[]; unblocked: DependentRefreshResult[]; stillBlocked: DependentRefreshResult[]; skipped: DependentRefreshResult[] };
  plan: LifecyclePlan;
  nextCommand: string;
  warnings: string[];
  errors: string[];
}

export interface CompleteOptions {
  issueNumber: number;
  dryRun: boolean;
  checkOnly: boolean;
  force: boolean;
  cwd?: string;
  exec?: GhExec;
  config?: Config;
}

function issueSummary(item: { key: { id: string }; title: string; state: 'open' | 'closed'; url: string | null; tags: readonly string[] }): StartIssueSummary {
  return { number: workItemKeyNumber({ providerId: 'github', id: item.key.id }, `work item ${item.key.id}`), title: item.title, state: item.state === 'open' ? 'OPEN' : 'CLOSED', url: item.url ?? '', labels: [...item.tags] };
}

function dependent(result: { item: { key: { id: string }; title: string; state: 'open' | 'closed'; url: string | null; tags: readonly string[] }; status: DependentRefreshResult['status']; openBlockers: number[]; addLabels: string[]; removeLabels: string[]; actionId: string | null; reason: string }): DependentRefreshResult {
  return { issue: issueSummary(result.item), status: result.status, openBlockers: result.openBlockers, addLabels: result.addLabels, removeLabels: result.removeLabels, actionId: result.actionId, reason: result.reason };
}

export async function completeIssue(options: CompleteOptions): Promise<CompleteResult> {
  const config = options.config ?? (await loadConfig(options.cwd)) ?? getDefaults();
  const context = await createLifecycleContext({ config, cwd: options.cwd, exec: options.exec, limit: 1000 });
  const service = await runCompleteService({ issueNumber: options.issueNumber, dryRun: options.dryRun, checkOnly: options.checkOnly, force: options.force, context });
  const dependents = service.dependentRefresh.dependents.map(dependent);
  const unblocked = service.dependentRefresh.unblocked.map(dependent);
  const stillBlocked = service.dependentRefresh.stillBlocked.map(dependent);
  const skipped = service.dependentRefresh.skipped.map(dependent);
  return {
    ok: service.ok,
    command: 'complete',
    dryRun: options.dryRun,
    checkOnly: options.checkOnly,
    forced: options.force,
    action: service.action,
    reason: service.reason,
    issue: issueSummary(service.item),
    checklist: service.checklist,
    completion: service.completion,
    milestoneContext: service.milestoneContext,
    dependentRefresh: { dependents, unblocked, stillBlocked, skipped },
    plan: service.plan,
    nextCommand: service.nextCommand,
    warnings: service.warnings,
    errors: service.errors.length > 0 ? service.errors : service.plan.summary.failedActions.map(action => action.failure?.cause ?? action.description),
  };
}
