import type { Action, ActionPlan } from './action_plan.js';
import { createAction, createActionPlan } from './action_plan.js';
import type { JsonObject } from './json_value.js';
import type { BranchPolicy } from './policy.js';
import type { RepoState } from './repo_state.js';
import type { WorkItem } from './work_item.js';

export interface BranchNameResult {
  branchName: string;
  patternError: string | null;
}

export interface BranchPlanRemoteState {
  remote: string;
  exists: boolean | null;
  revision: string | null;
  trackingRefPresent: boolean;
  relation: 'local-only' | 'remote-only' | 'none' | 'same' | 'local-ahead' | 'local-behind' | 'diverged' | 'unknown';
  localRevision: string | null;
  unavailableReason: string | null;
}

export interface BranchPlanStatus {
  branchName: string;
  currentBranch: string | null;
  matches: boolean;
  exists: boolean;
  validName: boolean;
  validationError: string | null;
  itemStatus: 'in-progress' | 'ready' | 'blocked' | 'unknown';
  remoteBranch: BranchPlanRemoteState;
  warnings: string[];
  blockers: string[];
}

export interface BranchPlanInspection {
  branchName: string;
  currentBranch: string | null;
  matches: boolean;
  exists: boolean;
  validName: boolean;
  validationError: string | null;
  itemStatus: 'in-progress' | 'ready' | 'blocked' | 'unknown';
  remoteBranch: BranchPlanRemoteState;
  repoState: RepoState;
}

export type PreStartBranchCheckName = 'worktree' | 'dirty-worktree' | 'base-ref';

export interface PreStartBranchCheck {
  name: PreStartBranchCheckName;
  ok: boolean;
  skipped: boolean;
  reason?: string;
  details: JsonObject;
}

function makeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function validateBranchPattern(pattern: string): string | null {
  if (!pattern.includes('<number>') || !pattern.includes('<slug>')) {
    return 'Branch naming pattern must include <number> and <slug> placeholders.';
  }
  if (/\s/.test(pattern)) return 'Branch naming pattern must not contain whitespace.';
  return null;
}

export function suggestBranchNameFromParts(input: { id: string; title: string }, policy: BranchPolicy): BranchNameResult {
  const patternError = validateBranchPattern(policy.pattern);
  const branchName = policy.pattern
    .replaceAll('<number>', input.id)
    .replaceAll('<slug>', makeSlug(input.title));
  return { branchName, patternError };
}

export function suggestBranchName(item: WorkItem, policy: BranchPolicy): BranchNameResult {
  return suggestBranchNameFromParts({ id: item.key.id, title: item.title }, policy);
}

export function evaluateBranchPlanStatus(inspection: BranchPlanInspection, policy: BranchPolicy): BranchPlanStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const remote = inspection.remoteBranch;
  const recoveringRemoteBranch = !inspection.exists && remote.exists === true;
  const creatingNewBranch = !inspection.exists && !inspection.matches && !recoveringRemoteBranch;
  if (!inspection.repoState.root) blockers.push('Not inside a git repository. Run branch creation from the repository checkout.');
  if (!inspection.validName) blockers.push(inspection.validationError ?? 'Configured branch name is invalid.');
  if (policy.requirePrimaryCheckout && inspection.repoState.worktree.linked) blockers.push('Linked git worktree detected. Use the primary checkout before creating an issue branch.');
  if (inspection.repoState.dirty.error) blockers.push(`Working tree status unavailable: ${inspection.repoState.dirty.error}`);
  if (inspection.repoState.dirty.dirty) blockers.push('Working tree has uncommitted or untracked changes. Commit or stash them before switching branches.');
  if (creatingNewBranch && policy.requireFreshBase && (!inspection.repoState.baseRef.revision || !inspection.repoState.baseRef.upToDate)) {
    blockers.push(`Base branch ${policy.baseRemote}/${policy.baseBranch} is ${inspection.repoState.baseRef.revision ? 'not current locally' : 'not resolved'}.`);
  }
  if (inspection.exists && remote.relation === 'diverged') {
    blockers.push(`Local branch ${inspection.branchName} (${remote.localRevision}) and ${remote.remote}/${inspection.branchName} (${remote.revision}) have diverged. Fetch the remote and reconcile with a merge or rebase onto ${remote.revision}; do not recreate the branch or force-push.`);
  }
  if (!inspection.exists && remote.exists === null) {
    if (inspection.itemStatus === 'in-progress') {
      blockers.push(`Remote ${remote.remote} could not be queried for ${inspection.branchName} while the issue is in progress (${remote.unavailableReason ?? 'remote lookup failed'}). An existing implementation branch may exist; restore remote connectivity and rerun instead of creating a parallel branch from ${policy.baseBranch}.`);
    } else {
      warnings.push(`Remote ${remote.remote} could not be queried for ${inspection.branchName} (${remote.unavailableReason ?? 'remote lookup failed'}); creating from ${policy.baseBranch} without remote verification.`);
    }
  }
  return {
    branchName: inspection.branchName,
    currentBranch: inspection.currentBranch,
    matches: inspection.matches,
    exists: inspection.exists,
    validName: inspection.validName,
    validationError: inspection.validationError,
    itemStatus: inspection.itemStatus,
    remoteBranch: remote,
    warnings,
    blockers,
  };
}

function createBranchAction(status: BranchPlanStatus, repoState: RepoState, policy: BranchPolicy): Action {
  const recoveringRemoteBranch = !status.exists && status.remoteBranch.exists === true;
  const description = status.matches
    ? `Already on branch ${status.branchName}`
    : status.exists
      ? `Check out existing branch ${status.branchName}`
      : recoveringRemoteBranch
        ? `Create tracking branch ${status.branchName} from ${status.remoteBranch.remote}/${status.branchName} at ${status.remoteBranch.revision}`
        : `Create branch ${status.branchName} from ${policy.baseBranch}`;
  const failure = status.blockers.length === 0 ? null : {
    operation: 'create issue branch',
    cause: status.blockers.join(' '),
    nextAction: 'Resolve the branch policy blocker, then rerun `aie branch create <issue> --dry-run`.',
  };
  return createAction({
    id: `create-branch:${status.branchName}`,
    kind: 'create-branch',
    target: { kind: 'repository', id: 'current' },
    mutation: 'repository-provider',
    description,
    expectedResult: 'Repository is on the issue branch without destructive git operations.',
    status: status.blockers.length > 0 ? 'failed' : status.matches ? 'completed' : 'planned',
    failure,
    details: {
      suggested: status.branchName,
      current: status.currentBranch,
      exists: status.exists,
      createFrom: status.matches || status.exists ? 'local' : recoveringRemoteBranch ? 'remote-tracking' : 'base',
      remoteName: status.remoteBranch.remote,
      remoteExists: status.remoteBranch.exists,
      remoteRevision: status.remoteBranch.revision,
      remoteTrackingRefPresent: status.remoteBranch.trackingRefPresent,
      remoteRelation: status.remoteBranch.relation,
      localRevision: status.remoteBranch.localRevision,
      baseBranch: policy.baseBranch,
      baseRemote: policy.baseRemote,
      repoRoot: repoState.root,
      warnings: status.warnings,
      blockers: status.blockers,
    },
  });
}

export function planBranchSuggestion(status: BranchPlanStatus): ActionPlan {
  return createActionPlan({
    id: `branch:suggest:${status.branchName}`,
    purpose: 'Suggest a policy-compliant issue branch name.',
    dryRun: true,
    actions: [createAction({
      id: `suggest-branch:${status.branchName}`,
      kind: 'verify-repository',
      target: { kind: 'repository', id: 'current' },
      mutation: 'none',
      description: `Suggest branch ${status.branchName}`,
      expectedResult: 'Suggested branch follows repository branch naming policy.',
      status: status.validName ? 'completed' : 'failed',
      failure: status.validName ? null : {
        operation: 'suggest issue branch',
        cause: status.validationError ?? 'Configured branch name is invalid.',
        nextAction: 'Fix branchNaming in Executor config, then rerun `aie branch suggest <issue>`.',
      },
      details: { suggested: status.branchName, patternValid: status.validName, validationError: status.validationError },
    })],
  });
}

export function planBranchCheck(status: BranchPlanStatus): ActionPlan {
  return createActionPlan({
    id: `branch:check:${status.branchName}`,
    purpose: 'Verify the current branch matches the issue branch policy.',
    dryRun: true,
    actions: [createAction({
      id: `check-branch:${status.branchName}`,
      kind: 'verify-repository',
      target: { kind: 'repository', id: 'current' },
      mutation: 'none',
      description: `Verify current branch matches ${status.branchName}`,
      expectedResult: 'Current branch matches the issue branch policy.',
      status: status.matches ? 'completed' : 'failed',
      failure: status.matches ? null : {
        operation: 'verify issue branch',
        cause: `Current branch ${status.currentBranch ?? 'none'} does not match ${status.branchName}.`,
        nextAction: 'Run `aie branch create <issue> --dry-run`, then switch to the suggested branch when safe.',
      },
      details: { suggested: status.branchName, current: status.currentBranch, matches: status.matches },
    })],
  });
}

export function planBranchCreate(status: BranchPlanStatus, repoState: RepoState, policy: BranchPolicy, dryRun: boolean): ActionPlan {
  return createActionPlan({
    id: `branch:create:${status.branchName}`,
    purpose: 'Create or switch to the policy-compliant issue branch.',
    dryRun,
    actions: [createBranchAction(status, repoState, policy)],
  });
}

function worktreeDetails(repoState: RepoState): JsonObject {
  return {
    isWorktree: repoState.worktree.linked,
    gitDir: repoState.worktree.gitDir,
    error: repoState.worktree.error,
  };
}

function baseRefDetails(repoState: RepoState, policy: BranchPolicy): JsonObject {
  return {
    remote: policy.baseRemote,
    branch: policy.baseBranch,
    resolved: repoState.baseRef.revision !== null,
    upToDate: repoState.baseRef.upToDate ?? null,
    localRevision: repoState.baseRef.revision,
    remoteRevision: repoState.baseRef.remoteRevision ?? null,
    error: repoState.baseRef.error ?? null,
  };
}

function dirtyDetails(repoState: RepoState): JsonObject {
  const prerequisite = repoState.prerequisites.checks.find(check => check.id === 'dirty-worktree');
  return {
    dirty: repoState.dirty.dirty,
    error: repoState.dirty.error,
    reasonCode: prerequisite?.reasonCode ?? null,
  };
}

export function evaluatePreStartBranchChecks(input: { repoState: RepoState; policy: BranchPolicy; bypassReason?: string }): PreStartBranchCheck[] {
  if (input.bypassReason) {
    return [
      { name: 'worktree', ok: true, skipped: true, reason: input.bypassReason, details: worktreeDetails(input.repoState) },
      { name: 'dirty-worktree', ok: true, skipped: true, reason: input.bypassReason, details: dirtyDetails(input.repoState) },
      { name: 'base-ref', ok: true, skipped: true, reason: input.bypassReason, details: baseRefDetails(input.repoState, input.policy) },
    ];
  }

  const worktreeOk = input.repoState.worktree.error === null && !(input.policy.requirePrimaryCheckout && input.repoState.worktree.linked);
  const baseRefResolved = input.repoState.baseRef.revision !== null;
  const baseRefUpToDate = input.repoState.baseRef.upToDate === true;
  const baseRefOk = !input.policy.requireFreshBase || (baseRefResolved && baseRefUpToDate);
  const dirtyOk = !input.repoState.dirty.dirty && input.repoState.dirty.error === null;
  return [
    {
      name: 'worktree',
      ok: worktreeOk,
      skipped: false,
      reason: worktreeOk ? undefined : input.repoState.worktree.error ?? 'Linked git worktree detected. Use the primary checkout before starting new issue work.',
      details: worktreeDetails(input.repoState),
    },
    {
      name: 'dirty-worktree',
      ok: dirtyOk,
      skipped: false,
      reason: dirtyOk ? undefined : input.repoState.dirty.error ?? 'Dirty git checkout detected. Preserve local changes before starting new issue work.',
      details: dirtyDetails(input.repoState),
    },
    {
      name: 'base-ref',
      ok: baseRefOk,
      skipped: false,
      reason: baseRefOk ? undefined : `Base branch ${input.policy.baseRemote}/${input.policy.baseBranch} is ${baseRefResolved ? 'not current locally' : 'not resolved'}.`,
      details: baseRefDetails(input.repoState, input.policy),
    },
  ];
}
