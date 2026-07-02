import type { ActionPlan } from './core/action_plan.js';
import type { ExecutorPolicy } from './core/policy.js';
import type { RepoState } from './core/repo_state.js';
import type { WorkItem } from './core/work_item.js';
import { Config, getDefaults, loadConfig } from './config/index.js';
import { configToExecutorPolicy } from './config_policy.js';
import type { GitHubIssue } from '@tjalve/qube-adapter-github';
import type { GhExec } from '@tjalve/qube-adapter-github';
import { createLocalGitRepositoryProvider, actionPlanWithResults, type GitExec, type GitRunResult } from './providers/local/local_git_provider.js';
import { createGitHubWorkProvider } from '@tjalve/qube-adapter-github';
import { githubIssueNumber, githubIssueToWorkItem } from '@tjalve/qube-adapter-github';
import { evaluateBranchPlanStatus, planBranchCheck, planBranchCreate, planBranchSuggestion, suggestBranchName as suggestWorkItemBranchName, validateBranchPattern } from './core/branch_rules.js';

export type { GitExec, GitRunResult };

export interface BranchIssueSummary {
  number: number;
  title: string;
  state: string;
  url: string;
}

export interface BranchDirtyStatus {
  dirty: boolean;
  entries: string[];
  error: string | null;
}

export interface BranchWorktreeStatus {
  isWorktree: boolean;
  gitDir?: string;
  error?: string;
}

export interface BranchBaseRefStatus {
  remote: string;
  branch: string;
  resolved: boolean;
  localRevision?: string;
  remoteRevision?: string;
  upToDate: boolean;
  error?: string;
}

export interface BranchStatus {
  suggested: string;
  current: string | null;
  matches: boolean;
  exists: boolean;
  validName: boolean;
  validationError: string | null;
  repoRoot: string | null;
  worktree: BranchWorktreeStatus;
  dirty: BranchDirtyStatus;
  baseRef: BranchBaseRefStatus;
  repoState: RepoState;
}

export interface BranchResult {
  ok: boolean;
  command: 'branch suggest' | 'branch check' | 'branch create';
  dryRun: boolean;
  issue: BranchIssueSummary;
  branch: BranchStatus;
  plan: ActionPlan;
  warnings: string[];
  errors: string[];
  nextAction: string;
}

export function parseBranchIssueNumber(input: string): number {
  const normalized = input.startsWith('#') ? input.slice(1) : input;
  const issueNumber = Number(normalized);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || String(issueNumber) !== normalized) {
    throw new Error(`Invalid issue number "${input}". Use a positive issue number such as 93 or #93.`);
  }
  return issueNumber;
}

export function suggestBranchName(issue: GitHubIssue, config: Config = getDefaults()): string {
  return suggestWorkItemBranchName(githubIssueToWorkItem(issue), configToExecutorPolicy(config).branch).branchName;
}

export { validateBranchPattern };

function issueSummary(item: WorkItem): BranchIssueSummary {
  return { number: githubIssueNumber(item), title: item.title, state: item.state === 'open' ? 'OPEN' : 'CLOSED', url: item.url ?? '' };
}

function branchStatus(input: {
  branchName: string;
  currentBranch: string | null;
  matches: boolean;
  exists: boolean;
  validName: boolean;
  validationError: string | null;
  repoState: RepoState;
  policy: ExecutorPolicy;
}): BranchStatus {
  const baseRevision = input.repoState.baseRef.revision ?? undefined;
  return {
    suggested: input.branchName,
    current: input.currentBranch,
    matches: input.matches,
    exists: input.exists,
    validName: input.validName,
    validationError: input.validationError,
    repoRoot: input.repoState.root,
    worktree: { isWorktree: input.repoState.worktree.linked, gitDir: input.repoState.worktree.gitDir ?? undefined, error: input.repoState.worktree.error ?? undefined },
    dirty: { dirty: input.repoState.dirty.dirty, entries: input.repoState.dirty.paths, error: input.repoState.dirty.error },
    baseRef: {
      remote: input.policy.branch.baseRemote,
      branch: input.policy.branch.baseBranch,
      resolved: input.repoState.baseRef.revision !== null,
      localRevision: baseRevision,
      remoteRevision: input.repoState.baseRef.remoteRevision ?? undefined,
      upToDate: input.repoState.baseRef.upToDate ?? false,
      error: input.repoState.baseRef.error ?? undefined,
    },
    repoState: input.repoState,
  };
}

function planOk(plan: ActionPlan): boolean {
  return plan.summary.failedCount === 0;
}

function plannedBlockers(plan: ActionPlan): string[] {
  return plan.actions.flatMap(action => {
    const blockers = action.details.blockers;
    return Array.isArray(blockers) && blockers.every(blocker => typeof blocker === 'string') ? blockers : [];
  });
}

function resultErrors(status: BranchStatus, plan: ActionPlan, blockers: string[]): string[] {
  return [
    ...(status.validName ? [] : [status.validationError ?? 'Configured branch name is invalid.']),
    ...blockers,
    ...plan.actions.filter(action => action.status === 'failed').map(action => action.failure?.cause ?? action.description),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function resultOk(command: BranchResult['command'], status: BranchStatus, plan: ActionPlan, blockers: string[]): boolean {
  if (command === 'branch suggest') return status.validName && planOk(plan);
  if (command === 'branch check') return status.validName && status.matches && planOk(plan);
  return blockers.length === 0 && planOk(plan);
}

function nextAction(command: BranchResult['command'], issueNumber: number, status: BranchStatus, ok: boolean): string {
  if (ok && command === 'branch suggest') return `Run \`aie branch check ${issueNumber}\` from the repository checkout.`;
  if (ok && command === 'branch check') return 'Current branch matches the issue branch policy.';
  if (ok && command === 'branch create') return `Continue work on ${status.suggested}.`;
  if (command === 'branch create') return 'Resolve the reported repository state blocker, then rerun `aie branch create <issue> --dry-run`.';
  return 'Switch to or create the suggested branch before shipping issue work.';
}

export async function runBranchCommand(input: {
  command: BranchResult['command'];
  issueNumber: number;
  dryRun?: boolean;
  exec?: GhExec;
  git?: GitExec;
  cwd?: string;
  config?: Config;
}): Promise<BranchResult> {
  const config = input.config ?? (await loadConfig(input.cwd)) ?? getDefaults();
  const policy = configToExecutorPolicy(config);
  const workProvider = createGitHubWorkProvider({ exec: input.exec, cwd: input.cwd });
  const item = await workProvider.getWorkItem({ providerId: 'github', id: String(input.issueNumber) });
  const repository = createLocalGitRepositoryProvider({ cwd: input.cwd, git: input.git });
  const inspection = await repository.inspectBranch(item, policy);
  const status = branchStatus({ ...inspection, policy });
  const planStatus = evaluateBranchPlanStatus(inspection, policy.branch);
  const initialPlan = input.command === 'branch suggest'
    ? planBranchSuggestion(planStatus)
    : input.command === 'branch check'
      ? planBranchCheck(planStatus)
      : planBranchCreate(planStatus, inspection.repoState, policy.branch, input.dryRun ?? false);
  const shouldApply = input.command === 'branch create' && !input.dryRun && initialPlan.actions.some(action => action.status === 'planned');
  const plan = shouldApply ? actionPlanWithResults(initialPlan, await repository.apply(initialPlan)) : initialPlan;
  const blockers = plannedBlockers(plan);
  const ok = resultOk(input.command, status, plan, blockers);
  return {
    ok,
    command: input.command,
    dryRun: input.dryRun ?? false,
    issue: issueSummary(item),
    branch: status,
    plan,
    warnings: inspection.repoState.warnings,
    errors: ok ? [] : resultErrors(status, plan, blockers),
    nextAction: nextAction(input.command, input.issueNumber, status, ok),
  };
}

export function suggestBranchNameForWorkItem(item: WorkItem, config: Config = getDefaults()): string {
  return suggestWorkItemBranchName(item, configToExecutorPolicy(config).branch).branchName;
}
