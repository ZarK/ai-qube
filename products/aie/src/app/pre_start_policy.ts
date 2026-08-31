import type { Config } from '../config/index.js';
import { configToExecutorPolicy } from '../config_policy.js';
import { evaluatePreStartBranchChecks, type PreStartBranchCheck as CorePreStartBranchCheck } from '../core/branch_rules.js';
import type { BranchPolicy } from '../core/policy.js';
import type { RepoState } from '../core/repo_state.js';
import type { GhExec } from '../providers/github_adapter_exports.js';
import {
  getPreStartNextActions,
  makePreStartPolicyCheck,
  type PreStartPolicyCheck,
  type PreStartPolicyResult,
} from '../lifecycle.js';
import { BaseRefStatus, listOpenPullRequests, PullRequestSummary, WorktreeStatus } from '../repo/index.js';
import { createLocalGitRepositoryProvider } from '../providers/local/local_git_provider.js';
import { findReviewSessionLocks, type ReviewSessionLockReport } from './local_review_runner_support.js';

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
  const reviewSessionLocks = repoState.root ? findReviewSessionLocks(repoState.root) : [];
  const checks = buildPreStartChecks(input.config, input.issueNumber, branchChecks, blockingPullRequests, reviewSessionLocks, input.bypassForResume ? bypassReason : undefined);
  const blockers = checks.filter(check => !check.ok && !check.skipped).map(check => check.reason ?? check.action.description);
  return {
    ok: blockers.length === 0,
    bypassed: input.bypassForResume,
    reason: input.bypassForResume ? bypassReason : undefined,
    prerequisites: repoState.prerequisites,
    worktree,
    baseRef,
    blockingPullRequests,
    checks,
    blockers,
    nextActions: getPreStartNextActions(blockers.length, input.config),
  };
}

function buildPreStartChecks(config: Config, issueNumber: number, branchChecks: CorePreStartBranchCheck[], blockingPullRequests: PullRequestSummary[], reviewSessionLocks: ReviewSessionLockReport[], bypassReason?: string): PreStartPolicyCheck[] {
  const worktree = getCoreBranchCheck(branchChecks, 'worktree');
  const dirtyWorktree = getCoreBranchCheck(branchChecks, 'dirty-worktree');
  const baseRef = getCoreBranchCheck(branchChecks, 'base-ref');
  const openPullRequestsOk = bypassReason ? true : !(config.blockOnOpenPRs && blockingPullRequests.length > 0);
  const reviewLockOk = bypassReason ? true : reviewSessionLocks.length === 0;
  const blockingLock = reviewSessionLocks[0];
  return [
    makePreStartPolicyCheck('worktree', issueNumber, worktree.ok, worktree.skipped, worktree.reason, worktree.details),
    makePreStartPolicyCheck('dirty-worktree', issueNumber, dirtyWorktree.ok, dirtyWorktree.skipped, dirtyWorktree.reason, dirtyWorktree.details),
    makePreStartPolicyCheck(
      'open-pull-requests',
      issueNumber,
      openPullRequestsOk,
      bypassReason !== undefined,
      bypassReason ?? (openPullRequestsOk ? undefined : `Open pull requests block new issue work: ${blockingPullRequests.map(pr => `#${pr.number}`).join(', ')}.`),
      { blockingPullRequests: blockingPullRequests.map(pr => ({ number: pr.number, title: pr.title, author: pr.author, url: pr.url })) },
    ),
    makePreStartPolicyCheck('base-ref', issueNumber, baseRef.ok, baseRef.skipped, baseRef.reason, baseRef.details),
    makePreStartPolicyCheck(
      'review-lock',
      issueNumber,
      reviewLockOk,
      bypassReason !== undefined,
      bypassReason ?? (reviewLockOk || !blockingLock
        ? undefined
        : blockingLock.stale
          ? `A stale review session lock blocks new issue work at ${blockingLock.path}. ${blockingLock.reason} ${blockingLock.cleanupCommand}`
          : `An active review session lock blocks new issue work at ${blockingLock.path}. ${blockingLock.reason} Wait for that review session to publish, or ${blockingLock.cleanupCommand}`),
      { reviewSessionLocks: reviewSessionLocks.map(lock => ({ path: lock.path, prNumber: lock.prNumber, stale: lock.stale, ageMinutes: lock.ageMinutes })) },
    ),
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
    upToDate: repoState.baseRef.upToDate ?? null,
    error: repoState.baseRef.error ?? undefined,
  };
}
