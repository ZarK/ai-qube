import type { Config } from '../config';
import { configToExecutorPolicy } from '../config_policy';
import { evaluatePreStartBranchChecks, type PreStartBranchCheck as CorePreStartBranchCheck } from '../core/branch_rules';
import type { BranchPolicy } from '../core/policy';
import type { RepoState } from '../core/repo_state';
import type { GhExec } from '../gh';
import {
  getPreStartNextActions,
  makePreStartPolicyCheck,
  type PreStartPolicyCheck,
  type PreStartPolicyResult,
} from '../lifecycle';
import { BaseRefStatus, listOpenPullRequests, PullRequestSummary, WorktreeStatus } from '../repo';
import { createLocalGitRepositoryProvider } from '../providers/local/local_git_provider';

export async function buildPreStartPolicy(input: {
  config: Config;
  issueNumber: number;
  bypassForResume: boolean;
  exec?: GhExec;
  cwd?: string;
}): Promise<PreStartPolicyResult> {
  const executorPolicy = configToExecutorPolicy(input.config);
  const repoState = await createLocalGitRepositoryProvider({ cwd: input.cwd }).inspect(executorPolicy);
  const worktree = repoStateToWorktreeStatus(repoState);
  const baseRef = repoStateToBaseRefStatus(repoState, executorPolicy.branch);
  const bypassReason = `Resuming the single active S-InProgress issue #${input.issueNumber}; pre-start repository freshness checks are not required.`;
  let blockingPullRequests: PullRequestSummary[] = [];
  if (!input.bypassForResume) {
    const pullRequests = await listOpenPullRequests(input.config, { exec: input.exec, cwd: repoState.root ?? input.cwd });
    blockingPullRequests = pullRequests.filter(pr => !pr.ignored);
  }
  const branchChecks = evaluatePreStartBranchChecks({
    repoState,
    policy: executorPolicy.branch,
    bypassReason: input.bypassForResume ? bypassReason : undefined,
  });
  const checks = buildPreStartChecks(input.config, input.issueNumber, branchChecks, blockingPullRequests, input.bypassForResume ? bypassReason : undefined);
  const blockers = checks.filter(check => !check.ok && !check.skipped).map(check => check.reason ?? check.action.description);
  return {
    ok: blockers.length === 0,
    bypassed: input.bypassForResume,
    reason: input.bypassForResume ? bypassReason : undefined,
    worktree,
    baseRef,
    blockingPullRequests,
    checks,
    blockers,
    nextActions: getPreStartNextActions(blockers.length, input.config),
  };
}

function buildPreStartChecks(config: Config, issueNumber: number, branchChecks: CorePreStartBranchCheck[], blockingPullRequests: PullRequestSummary[], bypassReason?: string): PreStartPolicyCheck[] {
  const worktree = getCoreBranchCheck(branchChecks, 'worktree');
  const baseRef = getCoreBranchCheck(branchChecks, 'base-ref');
  const openPullRequestsOk = bypassReason ? true : !(config.blockOnOpenPRs && blockingPullRequests.length > 0);
  return [
    makePreStartPolicyCheck('worktree', issueNumber, worktree.ok, worktree.skipped, worktree.reason, worktree.details),
    makePreStartPolicyCheck(
      'open-pull-requests',
      issueNumber,
      openPullRequestsOk,
      bypassReason !== undefined,
      bypassReason ?? (openPullRequestsOk ? undefined : `Open pull requests block new issue work: ${blockingPullRequests.map(pr => `#${pr.number}`).join(', ')}.`),
      { blockingPullRequests: blockingPullRequests.map(pr => ({ number: pr.number, title: pr.title, author: pr.author, url: pr.url })) },
    ),
    makePreStartPolicyCheck('base-ref', issueNumber, baseRef.ok, baseRef.skipped, baseRef.reason, baseRef.details),
  ];
}

function getCoreBranchCheck(checks: CorePreStartBranchCheck[], name: CorePreStartBranchCheck['name']): CorePreStartBranchCheck {
  const check = checks.find(candidate => candidate.name === name);
  if (!check) throw new Error(`Pre-start branch policy did not produce ${name} check.`);
  return check;
}

function repoStateToWorktreeStatus(repoState: RepoState): WorktreeStatus {
  return { isWorktree: repoState.worktree.linked, gitDir: repoState.worktree.gitDir ?? undefined, error: repoState.worktree.error ?? undefined };
}

function repoStateToBaseRefStatus(repoState: RepoState, policy: BranchPolicy): BaseRefStatus {
  return {
    remote: policy.baseRemote,
    branch: policy.baseBranch,
    resolved: repoState.baseRef.revision !== null,
    localRevision: repoState.baseRef.revision ?? undefined,
    remoteRevision: repoState.baseRef.remoteRevision ?? undefined,
    upToDate: repoState.baseRef.upToDate ?? false,
    error: repoState.baseRef.error ?? undefined,
  };
}
