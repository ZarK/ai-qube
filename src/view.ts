import { getDefaults, loadConfig, type Config } from './config';
import { configToExecutorPolicy } from './config_policy';
import type { GhExec } from './gh';
import { createLifecycleContext } from './app/lifecycle_services';
import { runViewService } from './app/view_work';
import { createLocalGitRepositoryProvider } from './providers/local/local_git_provider';
import { workItemNumber } from './core/work_item';
import type { BlockerDetail } from './deps';
export { suggestBranchName } from './branch';

export interface ChecklistSummary { total: number; checked: number; unchecked: number; items: string[] }
export interface BranchInfo { suggested: string; current: string | null; matches: boolean }
export interface MilestoneContext { number: number; title: string; state: string; dueOn: string | null; openIssues: number | null; closedIssues: number | null }

export interface ViewIssueResult {
  ok: boolean;
  issue: { number: number; title: string; state: string; url: string; labels: string[]; priority: string | null; statusLabel: string | null; componentLabels: string[]; effectiveStatus: 'InProgress' | 'Ready' | 'Blocked' | 'Closed'; body: string };
  milestone: MilestoneContext | null;
  dependency: { declaredBlockers: number[]; openBlockers: number[]; unresolvedBlockers: number[]; blockers: BlockerDetail[]; dependents: BlockerDetail[] };
  checklist: ChecklistSummary;
  branch: BranchInfo;
  warnings: string[];
  recommendedAction: string;
}

function priority(labels: string[], config: Config): string | null {
  return config.priorityLabels.find(label => labels.includes(label)) ?? null;
}

function status(labels: string[], config: Config): string | null {
  return config.statusLabels.find(label => labels.includes(label)) ?? null;
}

function components(labels: string[], config: Config): string[] {
  return labels.filter(label => config.componentLabels.includes(label));
}

async function currentBranch(options: { cwd?: string }): Promise<string | null> {
  const config = (await loadConfig(options.cwd)) ?? getDefaults();
  const repoState = await createLocalGitRepositoryProvider({ cwd: options.cwd }).inspect(configToExecutorPolicy(config));
  return repoState.activeRef?.kind === 'branch' ? repoState.activeRef.name : null;
}

export async function viewIssue(issueNumber: number, options: { exec?: GhExec; cwd?: string } = {}): Promise<ViewIssueResult> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('Issue number must be a positive integer.');
  const config = (await loadConfig(options.cwd)) ?? getDefaults();
  const context = await createLifecycleContext({ config, cwd: options.cwd, exec: options.exec, limit: 100 });
  const service = await runViewService({ issueNumber, context, currentBranch: await currentBranch(options) });
  const labels = [...service.item.tags];
  return {
    ok: true,
    issue: {
      number: workItemNumber(service.item),
      title: service.item.title,
      state: service.item.state === 'open' ? 'OPEN' : 'CLOSED',
      url: service.item.url ?? '',
      labels,
      priority: priority(labels, config),
      statusLabel: status(labels, config),
      componentLabels: components(labels, config),
      effectiveStatus: service.effectiveStatus,
      body: service.item.body,
    },
    milestone: service.milestone,
    dependency: service.dependency,
    checklist: service.checklist,
    branch: service.branch,
    warnings: service.warnings,
    recommendedAction: service.recommendedAction,
  };
}
