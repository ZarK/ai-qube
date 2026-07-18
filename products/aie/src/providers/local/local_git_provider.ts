import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Action, ActionPlan, ActionResult } from '../../core/action_plan.js';
import { createActionPlan } from '../../core/action_plan.js';
import { evaluateBranchPlanStatus, planBranchCheck, planBranchCreate, planBranchSuggestion, suggestBranchName } from '../../core/branch_rules.js';
import type { ExecutorPolicy } from '../../core/policy.js';
import { normalizeRepoState, type CiSignal, type PackageManagerSignal, type RepoRef, type RepoState } from '../../core/repo_state.js';
import type { WorkItem } from '../../core/work_item.js';
import type { BranchInspection, BranchRemoteState, RepositoryProvider, RepositoryProviderCapabilities } from '../repository_provider.js';

export interface GitRunResult {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitExec = (args: string[], options: { cwd: string }) => GitRunResult | Promise<GitRunResult>;

interface LocalGitProviderOptions {
  cwd?: string;
  git?: GitExec;
}

interface SyncGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGitSync(args: string[], cwd: string): SyncGitResult {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error: unknown) {
    return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function runGit(args: string[], cwd: string, git?: GitExec): Promise<GitRunResult> {
  if (git) return git(args, { cwd });
  const result = runGitSync(args, cwd);
  return { args, ...result };
}

function trimOutput(result: Pick<GitRunResult, 'stdout'> | SyncGitResult): string {
  return result.stdout.trim();
}

export function inspectRepoRoot(startDir = process.cwd()): string | null {
  const result = runGitSync(['rev-parse', '--show-toplevel'], startDir);
  return result.exitCode === 0 ? trimOutput(result) : null;
}

export function inspectWorktree(root: string | null): RepoState['worktree'] {
  if (!root) return { linked: false, gitDir: null, error: 'Not inside a git repository' };
  const result = runGitSync(['rev-parse', '--git-dir'], root);
  if (result.exitCode !== 0) return { linked: false, gitDir: null, error: trimOutput(result) || result.stderr.trim() || 'Failed to inspect git directory.' };
  const gitDir = trimOutput(result);
  const commonDir = runGitSync(['rev-parse', '--git-common-dir'], root);
  const normalizedGitDir = gitDir.replace(/\\/g, '/');
  const normalizedCommonDir = commonDir.exitCode === 0 ? trimOutput(commonDir).replace(/\\/g, '/') : normalizedGitDir;
  return { linked: normalizedGitDir !== normalizedCommonDir && normalizedGitDir.includes('/worktrees/'), gitDir, error: null };
}

export function inspectBaseRef(policy: ExecutorPolicy, root: string | null): RepoState['baseRef'] & { remoteRevision?: string; upToDate?: boolean; error?: string } {
  const baseRef = policy.branch;
  if (!root) return { name: baseRef.baseBranch, kind: 'branch', revision: null, remoteRevision: undefined, upToDate: false, error: 'Not inside a git repository' };
  const local = runGitSync(['rev-parse', '--verify', baseRef.baseBranch], root);
  const remote = runGitSync(['rev-parse', '--verify', `${baseRef.baseRemote}/${baseRef.baseBranch}`], root);
  if (local.exitCode !== 0 || remote.exitCode !== 0) {
    return { name: baseRef.baseBranch, kind: 'branch', revision: null, remoteRevision: undefined, upToDate: false, error: local.stderr.trim() || remote.stderr.trim() || 'Base ref is not resolved.' };
  }
  const localRevision = trimOutput(local);
  const remoteRevision = trimOutput(remote);
  return { name: baseRef.baseBranch, kind: 'branch', revision: localRevision, remoteRevision, upToDate: localRevision === remoteRevision };
}

async function inspectBaseRefWithGit(policy: ExecutorPolicy, root: string | null, git?: GitExec): Promise<RepoState['baseRef']> {
  const baseRef = policy.branch;
  if (!root) {
    return {
      name: baseRef.baseBranch,
      kind: 'branch',
      revision: null,
      remoteName: baseRef.baseRemote,
      remoteRevision: null,
      upToDate: false,
      error: 'Failed to inspect base branch. Likely cause: this command was not run from inside a git repository. Next action: rerun from the repository checkout.',
    };
  }
  const local = await runGit(['rev-parse', '--verify', baseRef.baseBranch], root, git);
  const remote = await runGit(['rev-parse', '--verify', `${baseRef.baseRemote}/${baseRef.baseBranch}`], root, git);
  if (local.exitCode !== 0 || remote.exitCode !== 0) {
    const cause = local.stderr.trim() || remote.stderr.trim() || 'The configured local or remote base branch ref could not be resolved.';
    return {
      name: baseRef.baseBranch,
      kind: 'branch',
      revision: null,
      remoteName: baseRef.baseRemote,
      remoteRevision: null,
      upToDate: false,
      error: `Failed to inspect base branch ${baseRef.baseRemote}/${baseRef.baseBranch}. Likely cause: ${cause} Next action: fetch ${baseRef.baseRemote} and verify ${baseRef.baseBranch} exists locally and remotely.`,
    };
  }
  const localRevision = trimOutput(local);
  const remoteRevision = trimOutput(remote);
  return {
    name: baseRef.baseBranch,
    kind: 'branch',
    revision: localRevision,
    remoteName: baseRef.baseRemote,
    remoteRevision,
    upToDate: localRevision === remoteRevision,
    error: null,
  };
}

function parseRemoteLines(stdout: string): RepoState['remotes'] {
  const remotes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (match) remotes.set(match[1], match[2]);
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
}

function packageSignals(root: string | null): PackageManagerSignal[] {
  if (!root || !existsSync(join(root, 'package.json'))) return [];
  const lockfiles: Array<[PackageManagerSignal['kind'], string]> = [
    ['npm', 'package-lock.json'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['bun', 'bun.lockb'],
  ];
  const match = lockfiles.find(([, lockfile]) => existsSync(join(root, lockfile)));
  return [{ kind: match?.[0] ?? 'unknown', manifestPath: 'package.json', lockfilePath: match ? match[1] : null }];
}

function ciSignals(root: string | null): CiSignal[] {
  const workflows = root ? join(root, '.github', 'workflows') : null;
  if (!workflows || !existsSync(workflows)) return [];
  return readdirSync(workflows).filter(name => name.endsWith('.yml') || name.endsWith('.yaml')).map(name => ({ kind: 'github-actions', path: join('.github', 'workflows', name) }));
}

function activeRefFromBranch(branch: string, revision: string | null): RepoRef | null {
  return branch === '' ? null : { name: branch, kind: 'branch', revision };
}

function actionResult(action: Action, status: ActionResult['status'], failure: ActionResult['failure'] = null): ActionResult {
  return { actionId: action.id, status, failure, details: action.details };
}

function getString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' ? value : null;
}

export class LocalGitRepositoryProvider implements RepositoryProvider {
  readonly id = 'local-git' as const;

  constructor(private readonly options: LocalGitProviderOptions = {}) {}

  capabilities(): RepositoryProviderCapabilities {
    return { inspectRepository: true, inspectBranch: true, planBranchActions: true, applyBranchActions: true };
  }

  async inspect(policy: ExecutorPolicy): Promise<RepoState> {
    const root = inspectRepoRoot(this.options.cwd);
    const cwd = root ?? this.options.cwd ?? process.cwd();
    const remotes = await runGit(['remote', '-v'], cwd, this.options.git);
    const current = root ? await runGit(['branch', '--show-current'], root, this.options.git) : null;
    const revision = root ? await runGit(['rev-parse', '--verify', 'HEAD'], root, this.options.git) : null;
    const status = root ? await runGit(['status', '--porcelain'], root, this.options.git) : null;
    const baseRef = await inspectBaseRefWithGit(policy, root, this.options.git);
    const dirtyPaths = status && status.exitCode === 0 ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
    const warnings: string[] = [];
    if (!root) warnings.push('Not inside a git repository.');
    if (remotes.exitCode !== 0) warnings.push(remotes.stderr.trim() || 'Failed to inspect git remotes.');
    if (status && status.exitCode !== 0) warnings.push(status.stderr.trim() || 'Failed to inspect git working tree.');
    if (baseRef.error) warnings.push(baseRef.error);
    if (baseRef.revision && baseRef.upToDate === false) warnings.push(`Base branch ${policy.branch.baseRemote}/${policy.branch.baseBranch} is not current locally.`);
    return normalizeRepoState({
      root,
      remotes: remotes.exitCode === 0 ? parseRemoteLines(remotes.stdout) : [],
      baseRef,
      activeRef: current && current.exitCode === 0 ? activeRefFromBranch(trimOutput(current), revision && revision.exitCode === 0 ? trimOutput(revision) : null) : null,
      dirty: { dirty: dirtyPaths.length > 0, paths: dirtyPaths, error: status && status.exitCode !== 0 ? status.stderr.trim() || 'Failed to inspect git working tree.' : null },
      worktree: inspectWorktree(root),
      projectRoots: root ? [{ path: '.', kind: existsSync(join(root, 'package.json')) ? 'package' : 'unknown' }] : [],
      packageManagers: packageSignals(root),
      ciSignals: ciSignals(root),
      generatedPathSignals: root && existsSync(join(root, 'dist')) ? [{ path: 'dist', reason: 'Generated package build output path exists.' }] : [],
      warnings,
    });
  }

  async inspectBranch(item: WorkItem, policy: ExecutorPolicy): Promise<BranchInspection> {
    const repoState = await this.inspect(policy);
    const { branchName, patternError } = suggestBranchName(item, policy.branch);
    const root = repoState.root;
    const nameError = patternError ?? await this.validateBranchName(branchName, root ?? this.options.cwd ?? process.cwd());
    const exists = root ? (await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], root, this.options.git)).exitCode === 0 : false;
    const currentBranch = repoState.activeRef?.kind === 'branch' ? repoState.activeRef.name : null;
    const remoteBranch = root
      ? await this.inspectRemoteBranch(root, branchName, policy.branch.baseRemote, exists)
      : { remote: policy.branch.baseRemote, exists: null, revision: null, trackingRefPresent: false, relation: 'unknown' as const, localRevision: null, unavailableReason: 'Not inside a git repository.' };
    return { branchName, currentBranch, matches: currentBranch === branchName, exists, validName: nameError === null, validationError: nameError, itemStatus: item.status, remoteBranch, repoState };
  }

  private async inspectRemoteBranch(root: string, branchName: string, remote: string, localExists: boolean): Promise<BranchRemoteState> {
    const localRevision = localExists
      ? trimOutput(await runGit(['rev-parse', '--verify', `refs/heads/${branchName}`], root, this.options.git)) || null
      : null;
    const trackingRef = `refs/remotes/${remote}/${branchName}`;
    const trackingResult = await runGit(['rev-parse', '--verify', '--quiet', trackingRef], root, this.options.git);
    let revision: string | null = trackingResult.exitCode === 0 ? trimOutput(trackingResult) || null : null;
    let trackingRefPresent = revision !== null;
    let unavailableReason: string | null = null;
    if (!trackingRefPresent) {
      // Bounded read-only lookup so a missing tracking ref never masks an
      // existing remote implementation branch.
      const lookup = await runGit(['ls-remote', '--heads', remote, branchName], root, this.options.git);
      if (lookup.exitCode !== 0) {
        unavailableReason = lookup.stderr.trim() || `Remote ${remote} could not be queried for ${branchName}.`;
        return { remote, exists: null, revision: null, trackingRefPresent, relation: 'unknown', localRevision, unavailableReason };
      }
      const line = trimOutput(lookup).split(/\r?\n/).find(entry => entry.endsWith(`refs/heads/${branchName}`));
      revision = line ? line.split(/\s+/)[0] ?? null : null;
    }
    if (!revision) {
      return { remote, exists: false, revision: null, trackingRefPresent, relation: localExists ? 'local-only' : 'none', localRevision, unavailableReason };
    }
    if (!localExists || !localRevision) {
      return { remote, exists: true, revision, trackingRefPresent, relation: 'remote-only', localRevision, unavailableReason };
    }
    if (localRevision === revision) {
      return { remote, exists: true, revision, trackingRefPresent, relation: 'same', localRevision, unavailableReason };
    }
    const localBehind = (await runGit(['merge-base', '--is-ancestor', localRevision, revision], root, this.options.git)).exitCode === 0;
    const localAhead = (await runGit(['merge-base', '--is-ancestor', revision, localRevision], root, this.options.git)).exitCode === 0;
    const relation = localBehind ? 'local-behind' : localAhead ? 'local-ahead' : 'diverged';
    return { remote, exists: true, revision, trackingRefPresent, relation, localRevision, unavailableReason };
  }

  async planBranchSuggestion(item: WorkItem, policy: ExecutorPolicy): Promise<ActionPlan> {
    return planBranchSuggestion(evaluateBranchPlanStatus(await this.inspectBranch(item, policy), policy.branch));
  }

  async planBranchCheck(item: WorkItem, policy: ExecutorPolicy): Promise<ActionPlan> {
    return planBranchCheck(evaluateBranchPlanStatus(await this.inspectBranch(item, policy), policy.branch));
  }

  async planBranchCreate(item: WorkItem, policy: ExecutorPolicy, options: { dryRun: boolean }): Promise<ActionPlan> {
    const inspection = await this.inspectBranch(item, policy);
    return planBranchCreate(evaluateBranchPlanStatus(inspection, policy.branch), inspection.repoState, policy.branch, options.dryRun);
  }

  async apply(plan: ActionPlan): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of plan.actions) {
      if (action.status !== 'planned') {
        results.push(actionResult(action, action.status === 'completed' ? 'completed' : action.status === 'failed' ? 'failed' : 'skipped', action.failure));
        continue;
      }
      try {
        await this.applyAction(action);
        results.push(actionResult(action, 'completed'));
      } catch (error: unknown) {
        const cause = error instanceof Error ? error.message : String(error);
        results.push(actionResult(action, 'failed', { operation: action.description, cause, nextAction: 'Resolve the repository state error, then rerun `aie branch create <issue> --dry-run`.' }));
      }
    }
    return results;
  }

  private async validateBranchName(branchName: string, cwd: string): Promise<string | null> {
    if (branchName.includes('<')) return 'Branch name still contains an unresolved placeholder.';
    const result = await runGit(['check-ref-format', '--branch', branchName], cwd, this.options.git);
    if (result.exitCode === 0) return null;
    return result.stderr.trim() || `Branch name "${branchName}" is not valid for git.`;
  }

  private async applyAction(action: Action): Promise<void> {
    if (action.kind !== 'create-branch') return;
    const root = getString(action.details, 'repoRoot');
    if (!root) throw new Error('Not inside a git repository.');
    const branchName = getString(action.details, 'suggested');
    if (!branchName) throw new Error('Branch action is missing the target branch name.');
    const exists = action.details.exists === true;
    const baseBranch = getString(action.details, 'baseBranch') ?? 'main';
    if (!exists && getString(action.details, 'createFrom') === 'remote-tracking') {
      const remoteName = getString(action.details, 'remoteName') ?? 'origin';
      if (action.details.remoteTrackingRefPresent !== true) {
        // The branch was discovered by a live lookup; fetch that one branch so
        // the remote-tracking ref exists before the tracking branch is created.
        const fetch = await runGit(['fetch', remoteName, branchName], root, this.options.git);
        if (fetch.exitCode !== 0) throw new Error(fetch.stderr.trim() || fetch.stdout.trim() || `git fetch ${remoteName} ${branchName} failed`);
      }
      const track = await runGit(['switch', '-c', branchName, '--track', `${remoteName}/${branchName}`], root, this.options.git);
      if (track.exitCode !== 0) throw new Error(track.stderr.trim() || track.stdout.trim() || `git switch -c ${branchName} --track ${remoteName}/${branchName} failed`);
      return;
    }
    const args = exists ? ['switch', branchName] : ['switch', '-c', branchName, baseBranch];
    const result = await runGit(args, root, this.options.git);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  }
}

export function createLocalGitRepositoryProvider(options: LocalGitProviderOptions = {}): LocalGitRepositoryProvider {
  return new LocalGitRepositoryProvider(options);
}

export function actionPlanWithResults(plan: ActionPlan, results: ActionResult[]): ActionPlan {
  const resultByAction = new Map(results.map(result => [result.actionId, result]));
  return createActionPlan({
    ...plan,
    actions: plan.actions.map(action => {
      const result = resultByAction.get(action.id);
      return result ? { ...action, status: result.status, failure: result.failure } : action;
    }),
  });
}
