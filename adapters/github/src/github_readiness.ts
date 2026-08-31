import { execFileSync } from 'node:child_process';

import { GhAuthError, GhExecutionError, GhMalformedOutputError, GhNetworkError, GhNotFoundError, NotGitHubRepositoryError, redact, runGh, type GhExec, type GhRunResult } from './gh.js';
import { resolveGitHubReviewPublisher, type GitHubReviewPublisherConfig } from './github_review_publisher.js';

export const GITHUB_PROVIDER_GUIDE_URL = 'https://github.com/ZarK/ai-qube/blob/main/docs/qube-github-provider-support.md';

export type GitHubReadinessStatus = 'ready' | 'needs-action' | 'unverified' | 'not-required';

export type GitHubReadinessReason =
  | 'not-required'
  | 'missing-cli'
  | 'unsupported-version'
  | 'host-unresolved'
  | 'unauthenticated'
  | 'wrong-account'
  | 'repo-inaccessible'
  | 'insufficient-permission'
  | 'sso-required'
  | 'app-not-installed'
  | 'credential-invalid'
  | 'network'
  | 'timeout'
  | 'unverified'
  | 'ready';

export type GitHubRole = 'work' | 'ci' | 'review' | 'setup-source' | 'labels' | 'repository-priming';

export type GitHubCapability =
  | 'repository-read'
  | 'issues-read'
  | 'issues-write'
  | 'labels-write'
  | 'pull-requests-read'
  | 'pull-request-reviews-write'
  | 'checks-read'
  | 'actions-read'
  | 'review-threads-write';

export type GitHubCredentialKind = 'none' | 'stored' | 'environment' | 'github-app' | 'named-token';

export interface GitHubCredentialSource {
  readonly kind: GitHubCredentialKind;
  readonly name: string | null;
}

export interface GitHubCapabilityReadiness {
  readonly capability: GitHubCapability;
  readonly status: GitHubReadinessStatus;
  readonly reasonCode: GitHubReadinessReason;
  readonly summary: string;
  readonly permission: string | null;
}

export interface GitHubReadiness {
  readonly status: GitHubReadinessStatus;
  readonly reasonCode: GitHubReadinessReason;
  readonly summary: string;
  readonly nextAction: string | null;
  readonly docsUrl: string;
  readonly cliVersion: string | null;
  readonly host: string | null;
  readonly repository: string | null;
  readonly accountLogin: string | null;
  readonly credentialSource: GitHubCredentialSource;
  readonly roles: readonly GitHubRole[];
  readonly capabilities: readonly GitHubCapabilityReadiness[];
}

export interface EvaluateGitHubReadinessOptions {
  readonly scope?: 'global' | 'repository';
  readonly offline?: boolean;
  readonly cwd?: string;
  readonly host?: string | null;
  readonly repository?: string | null;
  readonly remoteUrl?: string | null;
  readonly expectedLogin?: string | null;
  readonly roles?: readonly GitHubRole[];
  readonly capabilities?: readonly GitHubCapability[];
  readonly publisher?: GitHubReviewPublisherConfig | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exec?: GhExec;
  readonly timeoutMs?: number;
  readonly readRemote?: (cwd: string) => string | null;
}

interface RepositoryTarget {
  readonly host: string;
  readonly repository: string;
  readonly transport: 'https' | 'ssh' | 'unknown';
}

interface ActiveAccount {
  readonly login: string;
  readonly state: string;
  readonly tokenSource: string | null;
  readonly scopes: readonly string[];
}

interface ProbeFailure {
  readonly reasonCode: GitHubReadinessReason;
  readonly summary: string;
  readonly nextAction: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const ROLE_CAPABILITIES: Readonly<Record<GitHubRole, readonly GitHubCapability[]>> = Object.freeze({
  work: Object.freeze<GitHubCapability[]>(['repository-read', 'issues-read', 'issues-write', 'labels-write']),
  ci: Object.freeze<GitHubCapability[]>(['repository-read', 'checks-read', 'actions-read']),
  review: Object.freeze<GitHubCapability[]>(['repository-read', 'pull-requests-read', 'pull-request-reviews-write']),
  'setup-source': Object.freeze<GitHubCapability[]>(['repository-read']),
  labels: Object.freeze<GitHubCapability[]>(['repository-read', 'labels-write']),
  'repository-priming': Object.freeze<GitHubCapability[]>(['repository-read']),
});

const WRITE_CAPABILITIES = new Set<GitHubCapability>([
  'issues-write',
  'labels-write',
  'pull-request-reviews-write',
  'review-threads-write',
]);

export async function evaluateGitHubReadiness(options: EvaluateGitHubReadinessOptions = {}): Promise<GitHubReadiness> {
  const roles = unique(options.roles ?? []);
  const capabilities = unique(options.capabilities ?? roles.flatMap(role => ROLE_CAPABILITIES[role]));
  if (options.scope === 'global' || (roles.length === 0 && capabilities.length === 0)) {
    return readiness({
      status: 'not-required',
      reasonCode: 'not-required',
      summary: options.scope === 'global'
        ? 'GitHub CLI is not required or invoked during user-global setup.'
        : 'GitHub CLI is not required for the selected provider roles.',
      nextAction: null,
      roles,
      capabilities: [],
    });
  }
  if (options.offline) {
    return readiness({
      status: 'unverified',
      reasonCode: 'unverified',
      summary: 'Offline mode skipped every GitHub CLI and provider probe.',
      nextAction: 'Rerun without `--offline` when GitHub readiness can be verified.',
      roles,
      capabilities: capabilities.map(capability => capabilityReadiness(capability, 'unverified', 'unverified', 'Offline mode did not verify this capability.')),
    });
  }

  const env = options.env ?? process.env;
  const timeoutMs = positiveTimeout(options.timeoutMs);
  let versionResult: GhRunResult;
  try {
    versionResult = await runGh(['--version'], { cwd: options.cwd, exec: options.exec, env, timeoutMs });
  } catch (error) {
    const failure = classifyFailure(error, normalized(options.host) ?? 'the selected host');
    return failedReadiness(failure, roles, capabilities);
  }
  const cliVersion = parseCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!cliVersion) {
    return readiness({
      status: 'needs-action',
      reasonCode: 'unsupported-version',
      summary: 'The installed GitHub CLI did not report a supported semantic version.',
      nextAction: 'Update GitHub CLI using the official installation instructions, then rerun the command.',
      cliVersion: null,
      roles,
      capabilities: capabilities.map(capability => capabilityReadiness(capability, 'needs-action', 'unsupported-version', 'The installed CLI cannot run the structured readiness probe.')),
    });
  }
  const target = resolveTarget(options);
  if (!target) {
    return readiness({
      status: 'needs-action',
      reasonCode: 'host-unresolved',
      summary: 'The GitHub host and repository could not be derived from the selected repository.',
      nextAction: 'Configure an origin remote or an explicit GitHub host and owner/repository, then rerun the command.',
      cliVersion,
      roles,
      capabilities: capabilities.map(capability => capabilityReadiness(capability, 'needs-action', 'host-unresolved', 'Repository targeting is required before this capability can be checked.')),
    });
  }

  const publisherMode = options.publisher?.mode ?? 'user';
  const needsUserCredential = roles.some(role => role !== 'review') || publisherMode === 'user';
  const userSource = credentialSource(target.host, env);
  let account: ActiveAccount | null = null;
  if (needsUserCredential) {
    let authResult: GhRunResult;
    try {
      authResult = await runGh(['auth', 'status', '--active', '--hostname', target.host, '--json', 'hosts'], {
        cwd: options.cwd,
        exec: options.exec,
        env,
        timeoutMs,
      });
    } catch (error) {
      const failure = classifyFailure(error, target.host);
      return failedReadiness(failure, roles, capabilities, target, cliVersion, userSource);
    }
    if (authResult.exitCode !== 0) {
      const failure = classifyTextFailure(`${authResult.stderr}\n${authResult.stdout}`, target.host, 'unauthenticated');
      return failedReadiness(failure, roles, capabilities, target, cliVersion, userSource);
    }
    account = parseActiveAccount(authResult.stdout, target.host);
    if (!account) {
      return failedReadiness({
        reasonCode: 'unsupported-version',
        summary: 'GitHub CLI returned an unreadable structured authentication result.',
        nextAction: 'Update GitHub CLI, then rerun the command.',
      }, roles, capabilities, target, cliVersion, userSource);
    }
    if (account.state !== 'success') {
      const failure = classifyTextFailure(account.state, target.host, 'credential-invalid');
      return failedReadiness(failure, roles, capabilities, target, cliVersion, userSource, account.login);
    }
    const expectedLogin = normalized(options.expectedLogin);
    if (expectedLogin && account.login.toLowerCase() !== expectedLogin.toLowerCase()) {
      return failedReadiness({
        reasonCode: 'wrong-account',
        summary: `The active account on ${target.host} is ${account.login}, not the configured account ${expectedLogin}.`,
        nextAction: `Run \`gh auth switch --hostname ${target.host} --user ${expectedLogin}\` or add that host-specific login, then rerun the command.`,
      }, roles, capabilities, target, cliVersion, userSource, account.login);
    }
  }

  let publisherToken: string | null = null;
  let publisherSource: GitHubCredentialSource | null = null;
  let appReviewReady = false;
  let appThreadsReady = false;
  if (publisherMode === 'token') {
    const variable = normalized(options.publisher?.token?.env);
    publisherSource = { kind: 'named-token', name: variable };
    publisherToken = variable ? normalized(env[variable]) : null;
    if (!variable || !publisherToken) {
      return failedReadiness({
        reasonCode: 'credential-invalid',
        summary: `The configured review publisher token source ${variable ?? '(missing)'} is unavailable.`,
        nextAction: 'Set the configured publisher token environment variable, then rerun the command.',
      }, roles, capabilities, target, cliVersion, publisherSource, normalized(options.publisher?.token?.login));
    }
  } else if (publisherMode === 'github-app') {
    publisherSource = { kind: 'github-app', name: 'installation' };
    if (target.host !== 'github.com') {
      return failedReadiness({
        reasonCode: 'host-unresolved',
        summary: `GitHub App publication is not supported end to end for ${target.host}; setup stopped before provider writes.`,
        nextAction: 'Use a supported GitHub.com App publisher or select a user/token publisher supported by this Enterprise host.',
      }, roles, capabilities, target, cliVersion, publisherSource);
    }
    try {
      const resolved = await resolveGitHubReviewPublisher(options.publisher ?? null, {
        cwd: options.cwd,
        exec: options.exec,
        env,
        mint: true,
        timeoutMs,
      });
      publisherToken = resolved.accessToken;
      appReviewReady = resolved.identity.permissionStatus === 'ok' && resolved.identity.formalEventCapability;
      appThreadsReady = resolved.identity.contentsPermission === 'write';
      if (!publisherToken) {
        const reasonCode = /installation/i.test(resolved.identity.fallbackReason ?? '') ? 'app-not-installed' : 'credential-invalid';
        return failedReadiness({
          reasonCode,
          summary: resolved.identity.fallbackReason ?? 'The GitHub App installation credential could not be verified.',
          nextAction: 'Verify the App installation, repository access, and configured key reference, then rerun the command.',
        }, roles, capabilities, target, cliVersion, publisherSource, resolved.identity.login);
      }
      account = resolved.identity.login ? { login: resolved.identity.login, state: 'success', tokenSource: 'github-app', scopes: [] } : account;
    } catch (error) {
      const failure = classifyFailure(error, target.host, 'app-not-installed');
      return failedReadiness(failure, roles, capabilities, target, cliVersion, publisherSource);
    }
  }

  const source = publisherSource && !needsUserCredential ? publisherSource : userSource;
  let publisherBody: Record<string, unknown> | null = null;
  if (publisherSource) {
    try {
      publisherBody = await probeRepository(target, {
        cwd: options.cwd,
        exec: options.exec,
        env,
        token: publisherToken,
        timeoutMs,
      });
      if (publisherMode === 'token') {
        const loginResult = await runGh(['api', '--hostname', target.host, 'user'], {
          cwd: options.cwd,
          exec: options.exec,
          env,
          token: publisherToken,
          timeoutMs,
        });
        const loginBody = loginResult.exitCode === 0 ? parseRecord(loginResult.stdout) : null;
        const login = loginBody && typeof loginBody.login === 'string' ? loginBody.login : null;
        if (login) account = { login, state: 'success', tokenSource: publisherSource.name, scopes: [] };
        const expectedPublisherLogin = normalized(options.publisher?.token?.login);
        if (expectedPublisherLogin && login && login.toLowerCase() !== expectedPublisherLogin.toLowerCase()) {
          return failedReadiness({
            reasonCode: 'wrong-account',
            summary: `The named publisher token belongs to ${login}, not the configured account ${expectedPublisherLogin}.`,
            nextAction: `Set ${publisherSource.name} to the intended publisher credential, then rerun the command.`,
          }, roles, capabilities, target, cliVersion, publisherSource, login);
        }
      }
    } catch (error) {
      const failure = classifyFailure(error, target.host, publisherMode === 'github-app' ? 'app-not-installed' : 'credential-invalid');
      return failedReadiness(failure, roles, capabilities, target, cliVersion, publisherSource, account?.login ?? null);
    }
  }

  let repositoryBody: Record<string, unknown>;
  try {
    repositoryBody = needsUserCredential
      ? await probeRepository(target, { cwd: options.cwd, exec: options.exec, env, timeoutMs })
      : publisherBody ?? {};
  } catch (error) {
    const failure = classifyFailure(error, target.host, 'repo-inaccessible');
    return failedReadiness(failure, roles, capabilities, target, cliVersion, source, account?.login ?? null);
  }

  const hasIssues = repositoryBody.has_issues !== false;
  const rows = capabilities.map(capability => {
    if (capability === 'issues-read' && !hasIssues) {
      return capabilityReadiness(capability, 'needs-action', 'insufficient-permission', 'Issues are disabled or unavailable for this repository.', 'Issues read');
    }
    if (!WRITE_CAPABILITIES.has(capability)) {
      return capabilityReadiness(capability, 'ready', 'ready', 'The bounded repository probe verified this read capability.', permissionName(capability));
    }
    if (publisherMode === 'github-app' && capability === 'pull-request-reviews-write') {
      return appReviewReady
        ? capabilityReadiness(capability, 'ready', 'ready', 'The App installation reports Pull requests write permission.', 'Pull requests write')
        : capabilityReadiness(capability, 'needs-action', 'insufficient-permission', 'The App installation does not report Pull requests write permission.', 'Pull requests write');
    }
    if (publisherMode === 'github-app' && capability === 'review-threads-write') {
      return appThreadsReady
        ? capabilityReadiness(capability, 'ready', 'ready', 'The App installation reports the additional Contents write permission.', 'Contents write')
        : capabilityReadiness(capability, 'needs-action', 'insufficient-permission', 'The App installation does not report the additional Contents write permission.', 'Contents write');
    }
    return capabilityReadiness(capability, 'unverified', 'unverified', 'A read-only probe cannot prove this write capability; no mutation was attempted.', permissionName(capability));
  });
  const status = aggregate(rows);
  const first = rows.find(row => row.status === 'needs-action') ?? rows.find(row => row.status === 'unverified');
  return readiness({
    status,
    reasonCode: first?.reasonCode ?? 'ready',
    summary: status === 'ready'
      ? `GitHub CLI, ${target.host}, ${target.repository}, and every selected capability are ready.`
      : status === 'unverified'
        ? `GitHub authentication and repository access are ready; one or more write capabilities remain unverified without mutation.`
        : first?.summary ?? 'GitHub readiness needs action.',
    nextAction: status === 'ready'
      ? null
      : status === 'unverified'
        ? 'Confirm the named least-privilege write permissions, then rerun doctor or the explicitly requested provider command.'
        : recoveryFor(first?.reasonCode ?? 'insufficient-permission', target.host, account?.login ?? null),
    cliVersion,
    target,
    accountLogin: account?.login ?? null,
    credentialSource: source,
    roles,
    capabilities: rows,
  });
}

async function probeRepository(target: RepositoryTarget, options: {
  readonly cwd?: string;
  readonly exec?: GhExec;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly token?: string | null;
  readonly timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const result = await runGh(['api', '--hostname', target.host, `repos/${target.repository}`, '-H', 'Accept: application/vnd.github+json'], options);
  if (result.exitCode !== 0) throw new GhExecutionError(`gh api repos/${target.repository}`, result.exitCode, result.stderr || result.stdout);
  const body = parseRecord(result.stdout);
  if (!body) throw new GhMalformedOutputError(`gh api repos/${target.repository}`, 'Expected one JSON repository object.');
  return body;
}

export function githubCapabilitiesFor(roles: readonly GitHubRole[]): readonly GitHubCapability[] {
  return Object.freeze(unique(roles.flatMap(role => ROLE_CAPABILITIES[role])));
}

export function parseGitHubRemote(remoteUrl: string): RepositoryTarget | null {
  const raw = remoteUrl.trim();
  if (!raw || /[\r\n]/.test(raw)) return null;
  const scp = raw.match(/^(?:[^@\s]+@)?([^:/\s]+):([^/\s]+)\/(.+)$/);
  if (scp && !raw.includes('://')) return targetFromParts(scp[1], scp[2], scp[3], 'ssh');
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return null;
    const path = parsed.pathname.replace(/^\/+/, '');
    const [owner, ...nameParts] = path.split('/');
    return targetFromParts(parsed.hostname, owner, nameParts.join('/'), parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'ssh:' ? 'ssh' : 'unknown');
  } catch {
    return null;
  }
}

function resolveTarget(options: EvaluateGitHubReadinessOptions): RepositoryTarget | null {
  const host = normalized(options.host);
  const repository = normalizeRepository(options.repository);
  if (host && repository) return { host: host.toLowerCase(), repository, transport: 'unknown' };
  if (repository) return { host: host?.toLowerCase() ?? 'github.com', repository, transport: 'unknown' };
  const explicit = normalized(options.remoteUrl);
  if (explicit) {
    const target = parseGitHubRemote(explicit);
    return target && (!host || target.host === host.toLowerCase()) ? target : null;
  }
  const remote = (options.readRemote ?? defaultReadRemote)(options.cwd ?? process.cwd());
  if (!remote) return null;
  const target = parseGitHubRemote(remote);
  return target && (!host || target.host === host.toLowerCase()) ? target : null;
}

function targetFromParts(host: string | undefined, owner: string | undefined, rawName: string | undefined, transport: RepositoryTarget['transport']): RepositoryTarget | null {
  const safeHost = normalized(host)?.toLowerCase();
  const safeOwner = normalized(owner);
  const safeName = normalized(rawName)?.replace(/\.git$/i, '');
  if (!safeHost || !safeOwner || !safeName || safeName.includes('/')) return null;
  return { host: safeHost, repository: `${safeOwner}/${safeName}`, transport };
}

function defaultReadRemote(cwd: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function credentialSource(host: string, env: Readonly<Record<string, string | undefined>>): GitHubCredentialSource {
  const names = host === 'github.com' || host.endsWith('.ghe.com')
    ? ['GH_TOKEN', 'GITHUB_TOKEN']
    : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  for (const name of names) if (normalized(env[name])) return { kind: 'environment', name };
  return { kind: 'stored', name: 'gh credential store' };
}

function parseActiveAccount(stdout: string, host: string): ActiveAccount | null {
  const root = parseRecord(stdout);
  const hosts = root && isRecord(root.hosts) ? root.hosts : null;
  const accounts = hosts?.[host];
  if (!Array.isArray(accounts)) return null;
  const active = accounts.find(candidate => isRecord(candidate) && candidate.active === true);
  if (!isRecord(active) || typeof active.login !== 'string' || typeof active.state !== 'string') return null;
  const scopes = typeof active.scopes === 'string'
    ? active.scopes.split(',').map(scope => scope.trim()).filter(Boolean)
    : Array.isArray(active.scopes) ? active.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
  return {
    login: active.login,
    state: active.state.toLowerCase(),
    tokenSource: typeof active.tokenSource === 'string' ? active.tokenSource : null,
    scopes: Object.freeze(scopes),
  };
}

function classifyFailure(error: unknown, host: string, fallback: GitHubReadinessReason = 'unauthenticated'): ProbeFailure {
  if (error instanceof GhNotFoundError) return { reasonCode: 'missing-cli', summary: 'GitHub CLI is not installed or is not on PATH.', nextAction: 'Install GitHub CLI from https://cli.github.com/, then rerun the command.' };
  if (error instanceof GhAuthError) return { reasonCode: 'unauthenticated', summary: `No usable GitHub CLI credential is active for ${host}.`, nextAction: `Run \`gh auth login --hostname ${host}\`, then rerun the command.` };
  if (error instanceof NotGitHubRepositoryError) return { reasonCode: 'repo-inaccessible', summary: 'The selected GitHub repository could not be resolved or accessed.', nextAction: 'Verify the origin remote and repository access, then rerun the command.' };
  if (error instanceof GhNetworkError) return classifyTextFailure(error.message, host, 'network');
  if (error instanceof GhMalformedOutputError) return { reasonCode: 'unsupported-version', summary: 'GitHub CLI returned malformed structured output.', nextAction: 'Update GitHub CLI, then rerun the command.' };
  if (error instanceof GhExecutionError) return classifyTextFailure(`${error.message}\n${error.stderr}`, host, fallback);
  return classifyTextFailure(error instanceof Error ? error.message : String(error), host, fallback);
}

function classifyTextFailure(raw: string, host: string, fallback: GitHubReadinessReason): ProbeFailure {
  const text = redact(raw).toLowerCase();
  if (/timed?\s*out|etimedout|aborted/.test(text)) return { reasonCode: 'timeout', summary: 'The bounded GitHub readiness probe timed out.', nextAction: 'Check network or proxy access, then rerun the command.' };
  if (/sso|single sign-on|saml/.test(text)) return { reasonCode: 'sso-required', summary: 'The active credential requires organization SSO authorization.', nextAction: 'Authorize the credential for the organization SSO policy, then rerun the command.' };
  if (/installation.*not found|not installed|installation.*suspended/.test(text)) return { reasonCode: 'app-not-installed', summary: 'The configured GitHub App installation is unavailable for this repository.', nextAction: 'Install or restore the App for this repository, then rerun the command.' };
  if (/bad credentials|invalid token|expired|credential.*invalid/.test(text)) return { reasonCode: 'credential-invalid', summary: `The active credential for ${host} is invalid or expired.`, nextAction: `Repair the selected credential or run \`gh auth login --hostname ${host}\`, then rerun the command.` };
  if (/forbidden|permission|resource not accessible|403/.test(text)) return { reasonCode: 'insufficient-permission', summary: 'The active credential lacks a required GitHub permission.', nextAction: 'Grant the named least-privilege permission or select a credential that has it, then rerun the command.' };
  if (/not found|could not resolve|unknown repository|404/.test(text)) return { reasonCode: 'repo-inaccessible', summary: 'The selected GitHub repository is not visible to the active credential.', nextAction: 'Verify repository identity and credential access, then rerun the command.' };
  if (/network|econn|enotfound|getaddrinfo|socket|connection reset|tls|certificate/.test(text)) return { reasonCode: 'network', summary: 'The GitHub provider could not be reached.', nextAction: 'Check network, proxy, certificate, and GitHub service status, then rerun the command.' };
  if (fallback === 'app-not-installed') return { reasonCode: fallback, summary: 'The GitHub App installation could not be verified.', nextAction: 'Verify the App installation and configured credential references, then rerun the command.' };
  if (fallback === 'repo-inaccessible') return { reasonCode: fallback, summary: 'The selected GitHub repository could not be verified.', nextAction: 'Verify repository identity and credential access, then rerun the command.' };
  return { reasonCode: fallback, summary: `No usable GitHub credential is active for ${host}.`, nextAction: `Run \`gh auth login --hostname ${host}\`, then rerun the command.` };
}

function failedReadiness(
  failure: ProbeFailure,
  roles: readonly GitHubRole[],
  capabilities: readonly GitHubCapability[],
  target?: RepositoryTarget,
  cliVersion: string | null = null,
  source: GitHubCredentialSource = { kind: 'none', name: null },
  accountLogin: string | null = null,
): GitHubReadiness {
  return readiness({
    status: 'needs-action',
    reasonCode: failure.reasonCode,
    summary: failure.summary,
    nextAction: failure.nextAction,
    cliVersion,
    target,
    accountLogin,
    credentialSource: source,
    roles,
    capabilities: capabilities.map(capability => capabilityReadiness(capability, 'needs-action', failure.reasonCode, failure.summary, permissionName(capability))),
  });
}

function readiness(input: {
  readonly status: GitHubReadinessStatus;
  readonly reasonCode: GitHubReadinessReason;
  readonly summary: string;
  readonly nextAction: string | null;
  readonly cliVersion?: string | null;
  readonly target?: RepositoryTarget;
  readonly accountLogin?: string | null;
  readonly credentialSource?: GitHubCredentialSource;
  readonly roles: readonly GitHubRole[];
  readonly capabilities: readonly GitHubCapabilityReadiness[];
}): GitHubReadiness {
  return Object.freeze({
    status: input.status,
    reasonCode: input.reasonCode,
    summary: redact(input.summary),
    nextAction: input.nextAction ? redact(input.nextAction) : null,
    docsUrl: GITHUB_PROVIDER_GUIDE_URL,
    cliVersion: input.cliVersion ?? null,
    host: input.target?.host ?? null,
    repository: input.target?.repository ?? null,
    accountLogin: input.accountLogin ?? null,
    credentialSource: Object.freeze(input.credentialSource ?? { kind: 'none' as const, name: null }),
    roles: Object.freeze([...input.roles]),
    capabilities: Object.freeze([...input.capabilities]),
  });
}

function capabilityReadiness(capability: GitHubCapability, status: GitHubReadinessStatus, reasonCode: GitHubReadinessReason, summary: string, permission: string | null = null): GitHubCapabilityReadiness {
  return Object.freeze({ capability, status, reasonCode, summary: redact(summary), permission });
}

function permissionName(capability: GitHubCapability): string {
  const names: Record<GitHubCapability, string> = {
    'repository-read': 'Metadata read',
    'issues-read': 'Issues read',
    'issues-write': 'Issues write',
    'labels-write': 'Issues write',
    'pull-requests-read': 'Pull requests read',
    'pull-request-reviews-write': 'Pull requests write',
    'checks-read': 'Checks read',
    'actions-read': 'Actions read',
    'review-threads-write': 'Contents write',
  };
  return names[capability];
}

function aggregate(rows: readonly GitHubCapabilityReadiness[]): GitHubReadinessStatus {
  if (rows.some(row => row.status === 'needs-action')) return 'needs-action';
  if (rows.some(row => row.status === 'unverified')) return 'unverified';
  if (rows.every(row => row.status === 'not-required')) return 'not-required';
  return 'ready';
}

function recoveryFor(reason: GitHubReadinessReason, host: string, login: string | null): string {
  if (reason === 'wrong-account' && login) return `Run \`gh auth switch --hostname ${host} --user <login>\`, then rerun the command.`;
  if (reason === 'insufficient-permission') return 'Grant the named least-privilege permission, then rerun the command.';
  return `Run \`gh auth status --active --hostname ${host}\`, correct the reported problem, then rerun the command.`;
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function parseCliVersion(output: string): string | null {
  return output.match(/\bgh version\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)?.[1] ?? null;
}

function normalizeRepository(value: string | null | undefined): string | null {
  const text = normalized(value)?.replace(/\.git$/i, '');
  return text && /^[^/\s]+\/[^/\s]+$/.test(text) ? text : null;
}

function normalized(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
