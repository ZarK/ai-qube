export type RepoRefKind = 'branch' | 'tag' | 'detached' | 'unknown';

export interface RepoRef {
  name: string;
  kind: RepoRefKind;
  revision: string | null;
  remoteName?: string;
  remoteRevision?: string | null;
  upToDate?: boolean;
  error?: string | null;
}

export interface RepoRemote {
  name: string;
  url: string;
}

export type RepositoryPrerequisiteStatus = 'ready' | 'needs-action' | 'unverified' | 'not-required';

export type RepositoryPrerequisiteStage =
  | 'local-setup'
  | 'issue-workflow'
  | 'branch'
  | 'review'
  | 'completion'
  | 'shipping';

export type RepositoryPrerequisiteReasonCode =
  | 'git-not-found'
  | 'git-unsupported'
  | 'not-a-repository'
  | 'repository-unreadable'
  | 'identity-name-missing'
  | 'identity-email-missing'
  | 'head-missing'
  | 'detached-head'
  | 'linked-worktree'
  | 'dirty-worktree'
  | 'base-ref-missing'
  | 'base-ref-stale'
  | 'remote-missing'
  | 'remote-unreachable'
  | 'remote-auth-failed'
  | 'remote-unverified';

export interface RepositoryPrerequisiteCheck {
  id: 'git' | 'repository' | 'identity-name' | 'identity-email' | 'head' | 'branch' | 'worktree' | 'dirty-worktree' | 'base-ref' | 'remote' | 'remote-transport';
  requiredFor: RepositoryPrerequisiteStage[];
  status: RepositoryPrerequisiteStatus;
  reasonCode: RepositoryPrerequisiteReasonCode | null;
  summary: string;
  nextAction: string | null;
  docsUrl: string;
  safeDetails: Record<string, string | boolean | number | null>;
}

export interface RepositoryPrerequisites {
  status: RepositoryPrerequisiteStatus;
  checks: RepositoryPrerequisiteCheck[];
}

export interface DirtyState {
  dirty: boolean;
  paths: string[];
  error: string | null;
}

export interface WorktreeState {
  linked: boolean;
  gitDir: string | null;
  error: string | null;
}

export interface ProjectRoot {
  path: string;
  kind: 'package' | 'workspace' | 'app' | 'unknown';
}

export interface PackageManagerSignal {
  kind: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  manifestPath: string;
  lockfilePath: string | null;
}

export interface CiSignal {
  kind: 'github-actions' | 'other';
  path: string;
}

export interface PathSignal {
  path: string;
  reason: string;
}

export interface RepoState {
  root: string | null;
  prerequisites: RepositoryPrerequisites;
  remotes: RepoRemote[];
  baseRef: RepoRef;
  activeRef: RepoRef | null;
  dirty: DirtyState;
  worktree: WorktreeState;
  projectRoots: ProjectRoot[];
  packageManagers: PackageManagerSignal[];
  ciSignals: CiSignal[];
  generatedPathSignals: PathSignal[];
  warnings: string[];
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function normalizeRepoRef(input: RepoRef): RepoRef {
  return { ...input, name: nonEmpty(input.name, 'name') };
}

export function normalizeDirtyState(input: DirtyState): DirtyState {
  const paths = [...new Set(input.paths)];
  return { ...input, dirty: input.dirty || paths.length > 0, paths };
}

export function normalizeRepoState(input: RepoState): RepoState {
  return {
    ...input,
    remotes: input.remotes.map(remote => ({ name: nonEmpty(remote.name, 'remote.name'), url: nonEmpty(remote.url, 'remote.url') })),
    baseRef: normalizeRepoRef(input.baseRef),
    activeRef: input.activeRef ? normalizeRepoRef(input.activeRef) : null,
    dirty: normalizeDirtyState(input.dirty),
    warnings: [...new Set(input.warnings)],
  };
}
