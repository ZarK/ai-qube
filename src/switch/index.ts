import { getDefaults, loadConfig, Config } from '../config';
import { GhExec } from '../gh';
import {
  PreStartPolicyResult,
} from '../lifecycle';
import {
  createLifecycleContext,
} from '../app/lifecycle_services';
import { runSwitchService } from '../app/switch_work';
import { workItemNumber } from '../core/work_item';

export type SwitchAction = 'switched' | 'resumed' | 'blocked' | 'invalid';

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

export interface SwitchResult {
  ok: boolean;
  command: 'switch';
  dryRun: boolean;
  action: SwitchAction;
  reason: string;
  sourceIssue: StartIssueSummary | null;
  targetIssue: StartIssueSummary | null;
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

export interface SwitchOptions {
  targetIssueNumber: number;
  fromIssueNumber?: number;
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

function nextCommand(targetNumber: number, branchName: string, resumed: boolean): string {
  if (resumed) return `Continue work on #${targetNumber}; use branch ${branchName} for issue-coupled implementation.`;
  return `Create or check out branch ${branchName}, then implement #${targetNumber}.`;
}

export async function switchIssue(options: SwitchOptions): Promise<SwitchResult> {
  const config = options.config ?? (await loadConfig(options.cwd)) ?? getDefaults();
  const context = await createLifecycleContext({ config, cwd: options.cwd, exec: options.exec, limit: 1000 });
  const serviceResult = await runSwitchService({
    targetIssueNumber: options.targetIssueNumber,
    fromIssueNumber: options.fromIssueNumber,
    dryRun: options.dryRun,
    assign: config.assignOnStart && options.assign,
    comment: config.commentOnStart && options.comment,
    context,
  });

  const sourceItem = serviceResult.sourceItem;
  const targetItem = serviceResult.targetItem;
  const branchName = serviceResult.branchName;
  const resumed = serviceResult.action === 'resumed';

  return {
    ok: serviceResult.ok,
    command: 'switch',
    dryRun: options.dryRun,
    action: serviceResult.action,
    reason: serviceResult.reason,
    sourceIssue: sourceItem ? issueSummary(sourceItem) : null,
    targetIssue: targetItem ? issueSummary(targetItem) : null,
    blockers: serviceResult.blockers,
    activeIssueState: {
      inProgressCount: serviceResult.activeIssueState.inProgressCount,
      activeIssues: serviceResult.activeIssueState.activeIssues.map(issueSummary),
      multipleInProgress: serviceResult.activeIssueState.multipleInProgress,
    },
    preStartPolicy: serviceResult.preStartPolicy,
    branchRecommendation: {
      suggested: branchName || null,
      nextCommand: targetItem ? nextCommand(workItemNumber(targetItem), branchName, resumed) : 'Run `aie queue` to inspect active and ready issue work.',
    },
    plan: serviceResult.plan,
    warnings: serviceResult.warnings,
    errors: serviceResult.errors,
  };
}
