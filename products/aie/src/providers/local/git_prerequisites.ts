import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { homedir, platform } from 'os';
import { isAbsolute, join, normalize, resolve } from 'path';
import type {
  RepositoryPrerequisiteCheck,
  RepositoryPrerequisiteReasonCode,
  RepositoryPrerequisites,
  RepositoryPrerequisiteStage,
  RepositoryPrerequisiteStatus,
} from '../../core/repo_state.js';
import type { BranchPolicy } from '../../core/policy.js';
import type { GitExec, GitRunResult, GitRunOptions } from './local_git_provider.js';

export const MINIMUM_GIT_VERSION = '2.28.0';
export const GIT_DOWNLOADS_URL = 'https://git-scm.com/downloads';
export const GIT_SETUP_URL = 'https://git-scm.com/book/en/v2/Getting-Started-First-Time-Git-Setup';
export const GIT_CREDENTIALS_URL = 'https://git-scm.com/docs/gitcredentials';

export function safeGitTransportOptions(cwd: string): GitRunOptions {
  return {
    cwd,
    timeoutMs: 10_000,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=8',
    },
  };
}

const ALL_STAGES: RepositoryPrerequisiteStage[] = ['local-setup', 'issue-workflow', 'branch', 'review', 'completion', 'shipping'];
const WORKFLOW_STAGES: RepositoryPrerequisiteStage[] = ['issue-workflow', 'branch', 'review', 'completion', 'shipping'];
const REMOTE_STAGES: RepositoryPrerequisiteStage[] = ['issue-workflow', 'review', 'completion', 'shipping'];
const CHECK_STAGES: ReadonlyArray<readonly [RepositoryPrerequisiteCheck['id'], RepositoryPrerequisiteStage[]]> = [
  ['git', ALL_STAGES], ['repository', ALL_STAGES], ['identity-name', WORKFLOW_STAGES], ['identity-email', WORKFLOW_STAGES],
  ['head', WORKFLOW_STAGES], ['branch', WORKFLOW_STAGES], ['worktree', ['issue-workflow', 'branch']],
  ['dirty-worktree', ['issue-workflow', 'branch']], ['base-ref', WORKFLOW_STAGES], ['remote', REMOTE_STAGES], ['remote-transport', REMOTE_STAGES],
];

export interface EvaluateGitPrerequisitesOptions {
  cwd?: string;
  policy: { branch: Pick<BranchPolicy, 'baseRemote' | 'baseBranch' | 'requirePrimaryCheckout' | 'requireFreshBase'> };
  scope?: 'global' | 'repository';
  offline?: boolean;
  git?: GitExec;
  prospective?: boolean;
}

function check(
  id: RepositoryPrerequisiteCheck['id'],
  requiredFor: RepositoryPrerequisiteStage[],
  status: RepositoryPrerequisiteStatus,
  reasonCode: RepositoryPrerequisiteReasonCode | null,
  summary: string,
  nextAction: string | null,
  docsUrl: string,
  safeDetails: RepositoryPrerequisiteCheck['safeDetails'] = {},
): RepositoryPrerequisiteCheck {
  return { id, requiredFor, status, reasonCode, summary, nextAction, docsUrl, safeDetails };
}

function aggregate(checks: RepositoryPrerequisiteCheck[]): RepositoryPrerequisiteStatus {
  if (checks.every(candidate => candidate.status === 'not-required')) return 'not-required';
  if (checks.some(candidate => candidate.status === 'needs-action')) return 'needs-action';
  if (checks.some(candidate => candidate.status === 'unverified')) return 'unverified';
  return 'ready';
}

export function notRequiredGitPrerequisites(): RepositoryPrerequisites {
  return {
    status: 'not-required',
    checks: CHECK_STAGES.map(([id, requiredFor]) => check(id, requiredFor, 'not-required', null, 'Not required for user-global setup.', null, GIT_SETUP_URL)),
  };
}

function appendUnavailableChecks(rows: RepositoryPrerequisiteCheck[], observed: RepositoryPrerequisiteCheck['id'][], summary: string): void {
  const existing = new Set([...observed, ...rows.map(row => row.id)]);
  for (const [id, requiredFor] of CHECK_STAGES) {
    if (existing.has(id)) continue;
    rows.push(check(id, requiredFor, 'unverified', id === 'remote-transport' ? 'remote-unverified' : null, summary, null, id === 'remote' || id === 'remote-transport' ? GIT_CREDENTIALS_URL : GIT_SETUP_URL));
  }
}

function platformInstallAction(): { detectedPlatform: string; action: string } {
  const detectedPlatform = platform();
  if (detectedPlatform === 'win32') return { detectedPlatform: 'windows', action: `Install Git for Windows from ${GIT_DOWNLOADS_URL}, then rerun \`qube init\`.` };
  if (detectedPlatform === 'darwin') return { detectedPlatform: 'macos', action: `Install Git for macOS from ${GIT_DOWNLOADS_URL}, then rerun \`qube init\`.` };
  if (detectedPlatform === 'linux') return { detectedPlatform: 'linux', action: `Install Git using the maintained instructions at ${GIT_DOWNLOADS_URL}, then rerun \`qube init\`.` };
  return { detectedPlatform, action: `Install Git from ${GIT_DOWNLOADS_URL}, then rerun \`qube init\`.` };
}

function defaultGit(args: string[], options: GitRunOptions): GitRunResult {
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  try {
    const result = spawnSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env,
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    const spawnError = result.error as (Error & { code?: string }) | undefined;
    return {
      args,
      exitCode: result.status ?? (spawnError?.code === 'ENOENT' ? 127 : 1),
      stdout: result.stdout ?? '',
      stderr: spawnError?.message ?? result.stderr ?? '',
    };
  } catch (error: unknown) {
    const failure = error as Error & { code?: string };
    return { args, exitCode: failure.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: failure.message };
  }
}

async function invoke(git: GitExec | undefined, args: string[], options: GitRunOptions): Promise<GitRunResult> {
  return git ? git(args, options) : defaultGit(args, options);
}

function parseVersion(output: string): string | null {
  return output.match(/git version\s+(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? null;
}

function versionParts(value: string): number[] {
  return value.split('.').map(part => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function hasGitMarker(cwd: string): boolean {
  try {
    return existsSync(join(cwd, '.git'));
  } catch {
    return false;
  }
}

function cleanRoot(root: string, cwd: string): string | null {
  const candidate = root.trim();
  if (!candidate || !isAbsolute(candidate)) return null;
  try {
    realpathSync(candidate);
    return candidate;
  } catch {
    const resolved = resolve(cwd, candidate);
    return existsSync(resolved) ? normalize(resolved) : null;
  }
}

function identitySource(stdout: string, root: string): string | null {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) return null;
  const parts = line.split(/\t+/);
  const scope = parts[0]?.trim();
  const origin = parts[1]?.replace(/^file:/, '').trim();
  if (!scope) return null;
  if ((scope === 'local' || scope === 'worktree') && origin) {
    const localConfig = normalize(join(root, '.git', 'config')).toLowerCase();
    const normalizedOrigin = normalize(isAbsolute(origin) ? origin : resolve(root, origin)).toLowerCase();
    return scope === 'worktree' || normalizedOrigin === localConfig || /[\\/]\.git[\\/]worktrees[\\/].+[\\/]config(?:\.worktree)?$/i.test(normalizedOrigin)
      ? 'repository'
      : 'included';
  }
  if (scope === 'global' && origin) {
    const standard = [join(homedir(), '.gitconfig'), join(homedir(), '.config', 'git', 'config')].map(value => normalize(value).toLowerCase());
    return standard.includes(normalize(origin).toLowerCase()) ? 'user-global' : 'included';
  }
  if (scope === 'system') return 'system';
  if (scope === 'command') return 'command';
  return scope;
}

export function redactRemoteUrl(value: string): { url: string; transport: string } {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const transport = parsed.protocol.replace(/:$/, '').toLowerCase() || 'unknown';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.toString(), transport };
  } catch {
    const scp = trimmed.match(/^(?:[^@\s]+@)?([^:\s]+):(.+)$/);
    if (scp) return { url: `ssh://${scp[1]}/${scp[2].replace(/^\/+/, '')}`, transport: 'ssh' };
    if (isAbsolute(trimmed)) return { url: normalize(trimmed), transport: 'file' };
    return { url: '<redacted-remote>', transport: 'unknown' };
  }
}

export function redactGitError(value: string): string {
  return value
    .replace(/(?:https?|ssh):\/\/[^\s'"<>]+/gi, match => {
      const suffix = match.match(/[.,;:)]+$/)?.[0] ?? '';
      const candidate = suffix ? match.slice(0, -suffix.length) : match;
      return `${redactRemoteUrl(candidate).url}${suffix}`;
    })
    .replace(/(?:[^@\s'"<>]+@)?[^:\s'"<>]+:[^\s'"<>]+/g, match => {
      const suffix = match.match(/[.,;:)]+$/)?.[0] ?? '';
      const candidate = suffix ? match.slice(0, -suffix.length) : match;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return match;
      const remotePath = candidate.slice(candidate.indexOf(':') + 1);
      if (!candidate.includes('@') && !remotePath.includes('/') && !/\.git$/i.test(remotePath)) return match;
      return `${redactRemoteUrl(candidate).url}${suffix}`;
    })
    .replace(/\b(?:ghp|github_pat|glpat)-?[A-Za-z0-9_\-]{8,}\b/g, '<redacted>')
    .replace(/(?:password|token|authorization)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .trim();
}

export function classifyGitTransportFailure(stderr: string, timedOut = false): { reasonCode: RepositoryPrerequisiteReasonCode; category: string; summary: string } {
  const text = stderr.toLowerCase();
  if (timedOut) return { reasonCode: 'remote-unreachable', category: 'timeout', summary: 'The remote transport probe timed out.' };
  if (/authenticity of host|host key verification failed|known_hosts/.test(text)) return { reasonCode: 'remote-auth-failed', category: 'host-key', summary: 'The remote SSH host key could not be verified.' };
  if (/authentication failed|permission denied \(publickey|could not read username|terminal prompts disabled|invalid username or password/.test(text)) return { reasonCode: 'remote-auth-failed', category: 'authentication', summary: 'The remote rejected or could not obtain Git transport credentials.' };
  if (/authorization|not permitted|access denied|write access|403/.test(text)) return { reasonCode: 'remote-auth-failed', category: 'authorization', summary: 'The configured Git transport identity is not authorized for the remote.' };
  if (/repository not found|does not appear to be a git repository|not found|404/.test(text)) return { reasonCode: 'remote-unreachable', category: 'repository-not-found', summary: 'The configured remote repository was not found.' };
  return { reasonCode: 'remote-unreachable', category: 'network', summary: 'The configured remote could not be reached.' };
}

function selectedRemote(stdout: string, preferred: string): { name: string; url: string } | null {
  const remotes = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    const match = line.match(/^(\S+)\s+(\S+)(?:\s+\((fetch|push)\))?$/);
    return match && match[3] !== 'push' ? [{ name: match[1], url: match[2] }] : [];
  });
  return remotes.find(remote => remote.name === preferred) ?? remotes[0] ?? null;
}

export async function evaluateGitPrerequisites(options: EvaluateGitPrerequisitesOptions): Promise<RepositoryPrerequisites> {
  if ((options.scope ?? 'repository') === 'global') return notRequiredGitPrerequisites();
  const cwd = resolve(options.cwd ?? process.cwd());
  const rows: RepositoryPrerequisiteCheck[] = [];
  const version = await invoke(options.git, ['--version'], { cwd });
  const install = platformInstallAction();
  if (version.exitCode === 127 || /enoent|not recognized|not found/i.test(version.stderr)) {
    rows.push(check('git', ALL_STAGES, 'needs-action', 'git-not-found', 'The Git executable was not found.', install.action, GIT_DOWNLOADS_URL, { detectedPlatform: install.detectedPlatform, minimumVersion: MINIMUM_GIT_VERSION }));
    appendUnavailableChecks(rows, ['git'], 'Not evaluated because the Git executable is unavailable.');
    return { status: aggregate(rows), checks: rows };
  }
  const actualVersion = parseVersion(version.stdout || version.stderr);
  const capabilities = actualVersion && versionAtLeast(actualVersion, MINIMUM_GIT_VERSION)
    ? await invoke(options.git, ['help', '-a'], { cwd })
    : null;
  const capabilityText = `${capabilities?.stdout ?? ''}\n${capabilities?.stderr ?? ''}`;
  const capabilitiesReady = capabilities?.exitCode === 0 && /(?:^|\s)init(?:\s|$)/m.test(capabilityText) && /(?:^|\s)switch(?:\s|$)/m.test(capabilityText);
  if (!actualVersion || !versionAtLeast(actualVersion, MINIMUM_GIT_VERSION) || !capabilitiesReady) {
    rows.push(check('git', ALL_STAGES, 'needs-action', 'git-unsupported', `Git ${actualVersion ?? 'with an unknown version'} does not provide the required QUBE repository capabilities.`, install.action, GIT_DOWNLOADS_URL, { detectedPlatform: install.detectedPlatform, detectedVersion: actualVersion, minimumVersion: MINIMUM_GIT_VERSION, initInitialBranch: capabilityText.includes('init'), switchCommand: capabilityText.includes('switch') }));
    appendUnavailableChecks(rows, ['git'], 'Not evaluated because the required Git capabilities are unavailable.');
    return { status: aggregate(rows), checks: rows };
  }
  rows.push(check('git', ALL_STAGES, 'ready', null, `Git ${actualVersion} provides the required repository capabilities.`, null, GIT_DOWNLOADS_URL, { detectedVersion: actualVersion, minimumVersion: MINIMUM_GIT_VERSION }));

  const rootResult = await invoke(options.git, ['rev-parse', '--show-toplevel'], { cwd });
  const root = rootResult.exitCode === 0 ? cleanRoot(rootResult.stdout, cwd) : null;
  if (!root) {
    const prospective = options.prospective === true && !hasGitMarker(cwd);
    const unreadable = hasGitMarker(cwd) || !/not a git repository/i.test(rootResult.stderr);
    const reasonCode = unreadable ? 'repository-unreadable' : 'not-a-repository';
    rows.push(check('repository', ALL_STAGES, 'needs-action', reasonCode, prospective ? 'The target can be initialized as a Git repository.' : unreadable ? 'Git repository metadata could not be read.' : 'The target is not a Git repository.', prospective ? 'Confirm Git initialization or rerun with `qube init --git-init`.' : unreadable ? 'Repair repository metadata or permissions, then rerun `qube init`.' : 'Run `qube init --git-init` or initialize Git, then rerun `qube init`.', GIT_SETUP_URL, { prospective }));
    appendUnavailableChecks(rows, ['git', 'repository'], 'Not evaluated because readable Git repository metadata is unavailable.');
    return { status: aggregate(rows), checks: rows };
  }
  rows.push(check('repository', ALL_STAGES, 'ready', null, 'Git repository metadata is readable.', null, GIT_SETUP_URL, { root }));

  for (const [id, key, reasonCode, label] of [
    ['identity-name', 'user.name', 'identity-name-missing', 'Author name'],
    ['identity-email', 'user.email', 'identity-email-missing', 'Author email'],
  ] as const) {
    const result = await invoke(options.git, ['config', '--includes', '--show-origin', '--show-scope', '--get', key], { cwd: root });
    const source = result.exitCode === 0 ? identitySource(result.stdout, root) : null;
    rows.push(source
      ? check(id, WORKFLOW_STAGES, 'ready', null, `${label} is configured from ${source} Git configuration.`, null, GIT_SETUP_URL, { present: true, source })
      : check(id, WORKFLOW_STAGES, 'needs-action', reasonCode, `${label} is not configured.`, `Configure ${key} for this repository (recommended) or for all repositories, then rerun \`qube init\`.`, GIT_SETUP_URL, { present: false, source: null }));
  }

  const head = await invoke(options.git, ['rev-parse', '--verify', 'HEAD'], { cwd: root });
  const headReady = head.exitCode === 0;
  rows.push(headReady
    ? check('head', WORKFLOW_STAGES, 'ready', null, 'HEAD resolves to a commit.', null, GIT_SETUP_URL, { present: true, revision: head.stdout.trim() })
    : check('head', WORKFLOW_STAGES, 'needs-action', 'head-missing', 'The repository has no initial commit.', 'Review the local setup, create the initial commit, then rerun `qube init`.', GIT_SETUP_URL, { present: false }));

  const branch = await invoke(options.git, ['branch', '--show-current'], { cwd: root });
  const branchName = branch.exitCode === 0 ? branch.stdout.trim() : '';
  rows.push(branchName
    ? check('branch', WORKFLOW_STAGES, 'ready', null, `The current branch is ${branchName}.`, null, GIT_SETUP_URL, { detached: false, branch: branchName })
    : headReady
      ? check('branch', WORKFLOW_STAGES, 'needs-action', 'detached-head', 'HEAD is detached.', 'Switch to a named branch before starting issue work.', GIT_SETUP_URL, { detached: true, branch: null })
      : check('branch', WORKFLOW_STAGES, 'unverified', null, 'The unborn repository initial branch could not be confirmed.', 'Create or switch to a named initial branch before starting issue work.', GIT_SETUP_URL, { detached: null, branch: null }));

  const gitDir = await invoke(options.git, ['rev-parse', '--git-dir'], { cwd: root });
  const commonDir = await invoke(options.git, ['rev-parse', '--git-common-dir'], { cwd: root });
  const worktreeObserved = gitDir.exitCode === 0 && commonDir.exitCode === 0;
  const linked = worktreeObserved && normalize(gitDir.stdout.trim()) !== normalize(commonDir.stdout.trim()) && normalize(gitDir.stdout.trim()).replace(/\\/g, '/').includes('/worktrees/');
  rows.push(!worktreeObserved
    ? check('worktree', ['issue-workflow', 'branch'], 'unverified', null, 'The checkout type could not be inspected.', 'Repair repository metadata or permissions, then rerun diagnostics.', GIT_SETUP_URL, { linked: null, gitDir: null, inspectionError: true })
    : check('worktree', ['issue-workflow', 'branch'], linked && options.policy.branch.requirePrimaryCheckout ? 'needs-action' : 'ready', linked && options.policy.branch.requirePrimaryCheckout ? 'linked-worktree' : null, linked ? 'This is a linked Git worktree.' : 'This is the primary Git checkout.', linked && options.policy.branch.requirePrimaryCheckout ? 'Continue from the primary checkout before starting new issue work.' : null, GIT_SETUP_URL, { linked, gitDir: gitDir.stdout.trim(), inspectionError: false }));

  const status = await invoke(options.git, ['status', '--porcelain'], { cwd: root });
  const dirty = status.exitCode === 0 && status.stdout.trim() !== '';
  rows.push(status.exitCode !== 0
    ? check('dirty-worktree', ['issue-workflow', 'branch'], 'needs-action', 'dirty-worktree', 'The working tree state could not be inspected.', 'Repair repository metadata or permissions, then rerun diagnostics.', GIT_SETUP_URL, { dirty: null, inspectionError: true })
    : check('dirty-worktree', ['issue-workflow', 'branch'], dirty ? 'needs-action' : 'ready', dirty ? 'dirty-worktree' : null, dirty ? 'The working tree has local changes.' : 'The working tree is clean.', dirty ? 'Commit, stash, or otherwise preserve local changes before starting new issue work.' : null, GIT_SETUP_URL, { dirty, inspectionError: false }));

  const localBase = await invoke(options.git, ['rev-parse', '--verify', options.policy.branch.baseBranch], { cwd: root });
  const remoteBase = await invoke(options.git, ['rev-parse', '--verify', `${options.policy.branch.baseRemote}/${options.policy.branch.baseBranch}`], { cwd: root });
  const basePresent = localBase.exitCode === 0 && (!options.policy.branch.requireFreshBase || remoteBase.exitCode === 0);
  const baseCurrent = remoteBase.exitCode !== 0 || localBase.stdout.trim() === remoteBase.stdout.trim();
  const baseReady = basePresent && (!options.policy.branch.requireFreshBase || baseCurrent);
  rows.push(baseReady
    ? check('base-ref', WORKFLOW_STAGES, 'ready', null, `The configured base reference ${options.policy.branch.baseRemote}/${options.policy.branch.baseBranch} is available.`, null, GIT_SETUP_URL, { local: true, remoteTracking: remoteBase.exitCode === 0, upToDate: remoteBase.exitCode === 0 ? localBase.stdout.trim() === remoteBase.stdout.trim() : null })
    : check('base-ref', WORKFLOW_STAGES, 'needs-action', basePresent ? 'base-ref-stale' : 'base-ref-missing', basePresent ? `The configured base reference ${options.policy.branch.baseRemote}/${options.policy.branch.baseBranch} is not current locally.` : `The configured base reference ${options.policy.branch.baseRemote}/${options.policy.branch.baseBranch} is not available.`, `Create or fetch ${options.policy.branch.baseBranch} from ${options.policy.branch.baseRemote}, then rerun diagnostics.`, GIT_SETUP_URL, { local: localBase.exitCode === 0, remoteTracking: remoteBase.exitCode === 0, upToDate: basePresent ? baseCurrent : null }));

  const remoteList = await invoke(options.git, ['remote', 'get-url', '--all', options.policy.branch.baseRemote], { cwd: root });
  const fallbackRemotes = remoteList.exitCode === 0 ? remoteList : await invoke(options.git, ['remote', '-v'], { cwd: root });
  const remote = remoteList.exitCode === 0 && remoteList.stdout.trim()
    ? { name: options.policy.branch.baseRemote, url: remoteList.stdout.trim().split(/\r?\n/)[0] }
    : selectedRemote(fallbackRemotes.stdout, options.policy.branch.baseRemote);
  if (!remote) {
    rows.push(check('remote', REMOTE_STAGES, 'needs-action', 'remote-missing', 'No Git remote is configured for provider-backed workflows.', `Add the ${options.policy.branch.baseRemote} remote, then rerun \`qube init\`.`, GIT_CREDENTIALS_URL, { present: false }));
    rows.push(check('remote-transport', REMOTE_STAGES, 'unverified', 'remote-unverified', 'Remote transport cannot be checked because no remote is configured.', 'Configure a remote before checking transport access.', GIT_CREDENTIALS_URL, { probed: false }));
    return { status: aggregate(rows), checks: rows };
  }
  const safeRemote = redactRemoteUrl(remote.url);
  rows.push(check('remote', REMOTE_STAGES, 'ready', null, `Remote ${remote.name} uses ${safeRemote.transport} transport.`, null, GIT_CREDENTIALS_URL, { present: true, name: remote.name, url: safeRemote.url, transport: safeRemote.transport }));
  if (options.offline) {
    rows.push(check('remote-transport', REMOTE_STAGES, 'unverified', 'remote-unverified', 'Remote transport was not probed in offline mode.', 'Rerun `aie doctor` without `--offline` when network access is available.', GIT_CREDENTIALS_URL, { probed: false, name: remote.name, url: safeRemote.url, transport: safeRemote.transport }));
    return { status: aggregate(rows), checks: rows };
  }
  const probe = await invoke(options.git, ['ls-remote', remote.name, 'HEAD'], safeGitTransportOptions(root));
  if (probe.exitCode === 0) {
    rows.push(check('remote-transport', REMOTE_STAGES, 'ready', null, `Read access to remote ${remote.name} was verified. Push permission was not checked.`, null, GIT_CREDENTIALS_URL, { probed: true, readAccess: true, writeAccess: null, name: remote.name, url: safeRemote.url, transport: safeRemote.transport }));
  } else {
    const failure = classifyGitTransportFailure(probe.stderr, /timed out|etimedout/i.test(probe.stderr));
    rows.push(check('remote-transport', REMOTE_STAGES, 'needs-action', failure.reasonCode, failure.summary, 'Fix the reported Git transport issue, then rerun `aie doctor`.', GIT_CREDENTIALS_URL, { probed: true, readAccess: false, writeAccess: null, category: failure.category, error: redactGitError(probe.stderr), name: remote.name, url: safeRemote.url, transport: safeRemote.transport }));
  }
  return { status: aggregate(rows), checks: rows };
}

export function prerequisiteCheck(prerequisites: RepositoryPrerequisites, id: RepositoryPrerequisiteCheck['id']): RepositoryPrerequisiteCheck | undefined {
  return prerequisites.checks.find(candidate => candidate.id === id);
}

export function repositoryPrerequisiteStatusFor(prerequisites: RepositoryPrerequisites, stage: RepositoryPrerequisiteStage): RepositoryPrerequisiteStatus {
  const required = prerequisites.checks.filter(candidate => candidate.requiredFor.includes(stage));
  return required.length === 0 ? 'not-required' : aggregate(required);
}
