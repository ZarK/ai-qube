import { getDefaults, loadConfig, Config } from '../config';
import { GhExec } from '../gh';
import {
  LifecycleIssueSelection,
  PreStartPolicyResult,
} from '../lifecycle';
import {
  createLifecycleContext,
} from '../app/lifecycle_services';
import { runStartService } from '../app/start_work';
import { workItemNumber } from '../core/work_item';

export type StartAction = 'started' | 'resumed' | 'blocked' | 'empty' | 'invalid';

export interface StartBranchRecommendation {
  suggested: string | null;
  nextCommand: string;
}

export interface StartIssueSummary {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
}

export interface StartResult {
  ok: boolean;
  command: 'start';
  dryRun: boolean;
  action: StartAction;
  reason: string;
  issue: StartIssueSummary | null;
  selectedIssue: StartIssueSummary | null;
  blockers: number[];
  activeIssueState: {
    inProgressCount: number;
    activeIssues: StartIssueSummary[];
    multipleInProgress: boolean;
  };
  preStartPolicy?: PreStartPolicyResult;
  branchRecommendation: StartBranchRecommendation;
  plan: import('../lifecycle').LifecyclePlan;
  warnings: string[];
  errors: string[];
}

export interface StartOptions {
  selection: LifecycleIssueSelection;
  dryRun: boolean;
  assign: boolean;
  comment: boolean;
  cwd?: string;
  exec?: GhExec;
  config?: Config;
}

function issueSummary(item: import('../core/work_item').WorkItem): StartIssueSummary {
  return {
    number: workItemNumber(item),
    title: item.title,
    state: item.state === 'open' ? 'OPEN' : 'CLOSED',
    url: item.url ?? '',
    labels: [...item.tags],
  };
}

function startNextCommand(issueNumber: number, branchName: string, resumed: boolean): string {
  if (resumed) return `Continue work on #${issueNumber}; use branch ${branchName} for issue-coupled implementation.`;
  return `Create or check out branch ${branchName}, then implement #${issueNumber}.`;
}

export async function startIssue(options: StartOptions): Promise<StartResult> {
  const config = options.config ?? (await loadConfig(options.cwd)) ?? getDefaults();
  const context = await createLifecycleContext({ config, cwd: options.cwd, exec: options.exec, limit: 1000 });
  const serviceResult = await runStartService({
    selection: options.selection,
    dryRun: options.dryRun,
    assign: config.assignOnStart && options.assign,
    comment: config.commentOnStart && options.comment,
    context,
  });

  const selectedItem = serviceResult.selectedItem;
  const resumed = serviceResult.action === 'resumed';
  const branchName = serviceResult.branchName;

  return {
    ok: serviceResult.ok,
    command: 'start',
    dryRun: options.dryRun,
    action: serviceResult.action,
    reason: serviceResult.reason,
    issue: selectedItem ? issueSummary(selectedItem) : null,
    selectedIssue: selectedItem ? issueSummary(selectedItem) : null,
    blockers: serviceResult.blockers,
    activeIssueState: {
      inProgressCount: serviceResult.activeIssueState.inProgressCount,
      activeIssues: serviceResult.activeIssueState.activeIssues.map(issueSummary),
      multipleInProgress: serviceResult.activeIssueState.multipleInProgress,
    },
    preStartPolicy: serviceResult.preStartPolicy,
    branchRecommendation: {
      suggested: branchName || null,
      nextCommand: selectedItem ? startNextCommand(workItemNumber(selectedItem), branchName, resumed) : 'Run `aie queue` to inspect available issue work.',
    },
    plan: serviceResult.plan,
    warnings: serviceResult.warnings,
    errors: serviceResult.errors,
  };
}
