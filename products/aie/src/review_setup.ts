import type { Config, GitHubReviewPublisherConfig, GitHubReviewPublisherMode } from './config/index.js';
import type { GitHubReviewPublisherIdentity, ResolvedGitHubReviewPublisher } from '@tjalve/qube-adapter-github';
import { resolveGitHubReviewPublisher, runGh } from './providers/github_adapter_exports.js';

export const REVIEW_PUBLISHER_ROLE_BOUNDARY = 'QUBE and Executor guide setup and provider publishing only. Review compute remains host-run through local agents/subagents. Never send host/subagent credentials to GitHub; publisher credentials are provider communication credentials only.';

export interface ReviewSetupGuidance {
  readonly mode: 'github-app' | 'token';
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly limitation: string | null;
  readonly roleBoundary: string;
}

export type ReviewPublisherReadiness = 'ready' | 'degraded' | 'unavailable' | 'unconfigured';

export type ReviewPullRequestPermission = 'write' | 'read' | 'unknown';

export interface ReviewRepositoryProbeResult {
  readonly repository: string | null;
  readonly accessible: boolean;
  readonly pullRequestPermission: ReviewPullRequestPermission;
  readonly fallbackReason: string | null;
}

export interface ReviewRepositoryProbe extends ReviewRepositoryProbeResult {
  readonly attempted: boolean;
  readonly status: 'ok' | 'degraded' | 'failed' | 'not-run';
}

export interface ReviewPublisherProbe {
  readonly attempted: boolean;
  readonly status: 'ok' | 'degraded' | 'failed' | 'not-run';
  readonly permissionStatus: GitHubReviewPublisherIdentity['permissionStatus'] | null;
  readonly formalEventCapability: boolean | null;
  readonly fallbackReason: string | null;
  readonly repository: ReviewRepositoryProbe;
}

export interface ReviewDoctorResult {
  readonly ok: true;
  readonly command: 'review doctor';
  readonly readiness: ReviewPublisherReadiness;
  readonly mode: GitHubReviewPublisherMode;
  readonly identityClass: GitHubReviewPublisherIdentity['identityClass'];
  readonly login: string | null;
  readonly permissionStatus: GitHubReviewPublisherIdentity['permissionStatus'];
  readonly formalEventCapability: boolean;
  readonly fallbackReason: string | null;
  readonly missingFields: readonly string[];
  readonly secretReferences: Readonly<Record<string, string>>;
  readonly probe: ReviewPublisherProbe;
  readonly nextAction: string;
  readonly roleBoundary: string;
}

export type ReviewPublisherResolver = (
  config: GitHubReviewPublisherConfig | null | undefined,
  options?: { readonly cwd?: string; readonly mint?: boolean },
) => Promise<ResolvedGitHubReviewPublisher>;

export type ReviewRepositoryAccessProber = (options: {
  readonly cwd?: string;
  readonly accessToken: string | null;
  readonly identity: GitHubReviewPublisherIdentity;
}) => Promise<ReviewRepositoryProbeResult>;

export interface RunReviewDoctorOptions {
  readonly config: Config | null;
  readonly cwd?: string;
  readonly mintProbe?: boolean;
  readonly resolvePublisher?: ReviewPublisherResolver;
  readonly probeRepositoryAccess?: ReviewRepositoryAccessProber;
}

export function buildGitHubAppSetupGuidance(): ReviewSetupGuidance {
  return {
    mode: 'github-app',
    title: 'GitHub App reviewer publisher setup (preferred)',
    summary: 'Use a GitHub App installation as a distinct provider publishing identity for formal pull request review events.',
    requiredPermissions: ['Pull requests: Read and write', 'Contents: Read-only'],
    steps: [
      'Create or choose a user-owned GitHub App and grant Pull requests read/write plus Contents read-only repository permissions.',
      'Install the app only on the repositories where it may publish reviews; avoid broader installation scope than needed.',
      'Generate a private key and keep it outside repository files. Configure only a local filesystem path or an environment variable name containing the PEM.',
      'Find the installation id in the GitHub App installation URL or with `gh api /app/installations` while authenticated as the app owner.',
      'Apply local config with `review setup github-app --app-id <id> --installation-id <id> --private-key-env <ENV_NAME> --yes` (or use --private-key-path).',
      'Run `review doctor --json` for a read-only identity and permission probe. The probe mints only a short-lived installation token in memory.',
    ],
    limitation: null,
    roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}

export function buildTokenSetupGuidance(): ReviewSetupGuidance {
  return {
    mode: 'token',
    title: 'Fine-grained token reviewer publisher setup (fallback)',
    summary: 'Use a fine-grained personal access token owned by a separate reviewer user or bot account when a GitHub App is not practical.',
    requiredPermissions: ['Pull requests: Read and write', 'Contents: Read-only'],
    steps: [
      'Create or choose a separate GitHub user or bot account that is not the pull request author.',
      'Create a fine-grained personal access token scoped only to the required repositories with Pull requests read/write and Contents read-only permissions.',
      'Store the token in a local environment variable and pass only its variable name, for example `--token-env QUBE_REVIEW_TOKEN`.',
      'Apply local config with `review setup token --token-env <ENV_NAME> --login <public-login> --yes`.',
      'Run `review doctor --json` for a read-only identity and permission probe.',
    ],
    limitation: 'GitHub does not allow the pull request author to submit a formal review event on the same pull request. If the token identity is the author, publishing degrades to comment-state publication.',
    roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}

export function publisherMissingFields(publisher: GitHubReviewPublisherConfig | null | undefined): string[] {
  if (!publisher || publisher.mode === 'user') return [];
  if (publisher.mode === 'github-app') {
    const missing: string[] = [];
    if (!publisher.githubApp?.appId) missing.push('--app-id');
    if (!publisher.githubApp?.installationId) missing.push('--installation-id');
    if (!publisher.githubApp?.privateKeyEnv && !publisher.githubApp?.privateKeyPath) missing.push('--private-key-env or --private-key-path');
    if (publisher.githubApp?.privateKeyEnv && publisher.githubApp?.privateKeyPath) missing.push('exactly one of --private-key-env or --private-key-path');
    return missing;
  }
  return publisher.token?.env ? [] : ['--token-env'];
}

export function safeSecretReferences(publisher: GitHubReviewPublisherConfig | null | undefined): Readonly<Record<string, string>> {
  if (publisher?.mode === 'github-app') {
    return {
      ...(safeEnvironmentName(publisher.githubApp?.privateKeyEnv) ? { privateKeyEnv: publisher.githubApp?.privateKeyEnv as string } : {}),
      ...(safePathReference(publisher.githubApp?.privateKeyPath) ? { privateKeyPath: publisher.githubApp?.privateKeyPath as string } : {}),
    };
  }
  if (publisher?.mode === 'token' && safeEnvironmentName(publisher.token?.env)) return { tokenEnv: publisher.token?.env as string };
  return {};
}

function safeEnvironmentName(value: string | undefined): boolean {
  return typeof value === 'string'
    && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)
    && !/^(?:github_pat_|gh[pousr]_)/i.test(value)
    && !/BEGIN [A-Z ]*PRIVATE KEY/i.test(value);
}

function safePathReference(value: string | undefined): boolean {
  return typeof value === 'string'
    && value.length <= 1024
    && !/[\r\n]/.test(value)
    && !/BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_|github_pat_/i.test(value);
}

function sanitizeReason(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED TOKEN]');
}

function unavailableIdentity(mode: GitHubReviewPublisherMode, reason: string): GitHubReviewPublisherIdentity {
  return {
    mode,
    identityClass: 'none',
    login: null,
    permissionStatus: 'misconfigured',
    formalEventCapability: false,
    fallbackReason: reason,
    publishTransport: 'issue-comment',
    authSource: 'none',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRepositoryName(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) && typeof parsed.nameWithOwner === 'string' && parsed.nameWithOwner.includes('/')
      ? parsed.nameWithOwner
      : null;
  } catch {
    return null;
  }
}

function parseRepositoryBody(stdout: string): Record<string, unknown> | null {
  const bodyStart = stdout.search(/(?:^|\r?\n)\s*\{/);
  if (bodyStart < 0) return null;
  const jsonStart = stdout.indexOf('{', bodyStart);
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pullRequestPermissionFrom(identity: GitHubReviewPublisherIdentity): ReviewPullRequestPermission {
  if (identity.identityClass === 'github-app-installation') {
    return identity.permissionStatus === 'ok' ? 'write' : identity.permissionStatus === 'missing' ? 'read' : 'unknown';
  }
  // Repository role fields do not expose a fine-grained token's Pull requests scope.
  return 'unknown';
}

async function probeCurrentRepositoryAccess(options: {
  readonly cwd?: string;
  readonly accessToken: string | null;
  readonly identity: GitHubReviewPublisherIdentity;
}): Promise<ReviewRepositoryProbeResult> {
  if (!options.accessToken) {
    return {
      repository: null,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: 'Configured publisher credential did not yield an access token for the current-repository probe.',
    };
  }
  const repositoryResult = await runGh(['repo', 'view', '--json', 'nameWithOwner'], { cwd: options.cwd });
  const repository = repositoryResult.exitCode === 0 ? parseRepositoryName(repositoryResult.stdout) : null;
  if (!repository) {
    return {
      repository: null,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: 'Could not detect the current GitHub repository from the working directory.',
    };
  }
  const accessResult = await runGh([
    'api',
    `repos/${repository}`,
    '--include',
    '-H',
    'Accept: application/vnd.github+json',
  ], { cwd: options.cwd, token: options.accessToken });
  if (accessResult.exitCode !== 0) {
    return {
      repository,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: `Configured publisher cannot access the current repository ${repository}.`,
    };
  }
  const repositoryBody = parseRepositoryBody(accessResult.stdout);
  if (!repositoryBody) {
    return {
      repository,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: `Current-repository access probe for ${repository} returned an unreadable response.`,
    };
  }
  const pullRequestPermission = pullRequestPermissionFrom(options.identity);
  return {
    repository,
    accessible: true,
    pullRequestPermission,
    fallbackReason: pullRequestPermission === 'write'
      ? null
      : `Configured publisher can read ${repository} but Pull requests write permission was not confirmed.`,
  };
}

function notRunRepositoryProbe(): ReviewRepositoryProbe {
  return {
    attempted: false,
    status: 'not-run',
    repository: null,
    accessible: false,
    pullRequestPermission: 'unknown',
    fallbackReason: null,
  };
}

function repositoryProbe(result: ReviewRepositoryProbeResult): ReviewRepositoryProbe {
  return {
    attempted: true,
    status: !result.accessible ? 'failed' : result.pullRequestPermission === 'write' ? 'ok' : 'degraded',
    repository: result.repository,
    accessible: result.accessible,
    pullRequestPermission: result.pullRequestPermission,
    fallbackReason: sanitizeReason(result.fallbackReason),
  };
}

function readinessFor(
  identity: GitHubReviewPublisherIdentity,
  missingFields: readonly string[],
  configured: boolean,
  repository: ReviewRepositoryProbe,
): ReviewPublisherReadiness {
  if (!configured) return 'unconfigured';
  if (missingFields.length > 0 || identity.permissionStatus === 'misconfigured') return 'unavailable';
  if (identity.permissionStatus === 'same-author') return 'degraded';
  if (repository.attempted && !repository.accessible) return 'unavailable';
  if (!repository.attempted || repository.pullRequestPermission !== 'write') return 'degraded';
  if (identity.permissionStatus === 'ok' && identity.formalEventCapability) return 'ready';
  if (identity.permissionStatus === 'missing' && identity.identityClass === 'none') return 'unavailable';
  return 'degraded';
}

function nextActionFor(readiness: ReviewPublisherReadiness, mode: GitHubReviewPublisherMode, missingFields: readonly string[], probe: ReviewPublisherProbe): string {
  if (readiness === 'unconfigured') return 'Run `qube review setup github-app` (preferred) or `qube review setup token` (fallback).';
  if (missingFields.length > 0) return `Re-run \`qube review setup ${mode}\` with ${missingFields.join(' and ')}, then add --yes to apply the safe references.`;
  if (!probe.attempted) return 'Run `qube review doctor --json` without --no-probe after the referenced credential is available locally.';
  if (readiness === 'ready') return 'Publisher is ready. Continue using host-run review agents/subagents and publish their results through the configured provider identity.';
  if (probe.permissionStatus === 'same-author') return 'Use a GitHub App installation or token owned by an identity different from the pull request author.';
  if (probe.repository.attempted && !probe.repository.accessible) return `Grant the configured publisher access to the current repository${probe.repository.repository ? ` ${probe.repository.repository}` : ''}, then rerun \`qube review doctor --json\`.`;
  if (probe.repository.attempted && probe.repository.pullRequestPermission !== 'write') return 'Grant the configured publisher Pull requests read/write permission for the current repository, then rerun `qube review doctor --json`.';
  if (probe.permissionStatus === 'missing') return mode === 'github-app'
    ? 'Grant the installed GitHub App Pull requests read/write permission, refresh the installation, and rerun `qube review doctor --json`.'
    : 'Grant the fine-grained token Pull requests read/write access to the repository, then rerun `qube review doctor --json`.';
  return `Verify the configured ${mode} credential reference and repository access, then rerun \`qube review doctor --json\`.`;
}

export async function runReviewDoctor(options: RunReviewDoctorOptions): Promise<ReviewDoctorResult> {
  const publisher = options.config?.providers.review.publisher;
  const mode = publisher?.mode ?? 'user';
  const configured = Boolean(publisher && mode !== 'user');
  const missingFields = publisherMissingFields(publisher);
  const resolver = options.resolvePublisher ?? resolveGitHubReviewPublisher;
  const repositoryProber = options.probeRepositoryAccess ?? probeCurrentRepositoryAccess;
  let resolved: ResolvedGitHubReviewPublisher | null = null;
  let identity: GitHubReviewPublisherIdentity;
  try {
    if (missingFields.length > 0) {
      identity = unavailableIdentity(mode, `Publisher configuration is incomplete: ${missingFields.join(', ')}.`);
    } else {
      resolved = await resolver(publisher, { cwd: options.cwd, mint: options.mintProbe === true });
      identity = resolved.identity;
    }
  } catch (error: unknown) {
    identity = unavailableIdentity(mode, sanitizeReason(error instanceof Error ? error.message : String(error)) ?? 'Publisher resolution failed.');
  }
  identity = { ...identity, fallbackReason: sanitizeReason(identity.fallbackReason) };
  const attempted = configured && missingFields.length === 0 && options.mintProbe === true;
  let repository = notRunRepositoryProbe();
  if (attempted) {
    try {
      repository = repositoryProbe(await repositoryProber({
        cwd: options.cwd,
        accessToken: resolved?.accessToken ?? null,
        identity,
      }));
    } catch (error: unknown) {
      repository = repositoryProbe({
        repository: null,
        accessible: false,
        pullRequestPermission: 'unknown',
        fallbackReason: sanitizeReason(error instanceof Error ? error.message : String(error)) ?? 'Current-repository access probe failed.',
      });
    }
  }
  const readiness = readinessFor(identity, missingFields, configured, repository);
  const effectivePermissionStatus = identity.permissionStatus === 'same-author'
    ? 'same-author'
    : repository.attempted && (!repository.accessible || repository.pullRequestPermission !== 'write')
      ? 'missing'
      : identity.permissionStatus;
  const formalEventCapability = identity.formalEventCapability
    && repository.attempted
    && repository.accessible
    && repository.pullRequestPermission === 'write';
  const fallbackReason = identity.fallbackReason ?? repository.fallbackReason;
  const probe: ReviewPublisherProbe = {
    attempted,
    status: !attempted ? 'not-run' : readiness === 'ready' ? 'ok' : readiness === 'degraded' ? 'degraded' : 'failed',
    permissionStatus: attempted ? effectivePermissionStatus : null,
    formalEventCapability: attempted ? formalEventCapability : null,
    fallbackReason: attempted ? fallbackReason : null,
    repository,
  };
  return {
    ok: true,
    command: 'review doctor',
    readiness,
    mode,
    identityClass: identity.identityClass,
    login: identity.login,
    permissionStatus: effectivePermissionStatus,
    formalEventCapability,
    fallbackReason,
    missingFields,
    secretReferences: safeSecretReferences(publisher),
    probe,
    nextAction: nextActionFor(readiness, mode, missingFields, probe),
    roleBoundary: REVIEW_PUBLISHER_ROLE_BOUNDARY,
  };
}

export function formatReviewDoctor(result: ReviewDoctorResult): string {
  const references = Object.entries(result.secretReferences).map(([name, value]) => `${name}=${value}`).join(', ') || 'none';
  return [
    `Review publisher readiness: ${result.readiness}`,
    `Mode: ${result.mode}`,
    `Identity: ${result.identityClass}${result.login ? ` (${result.login})` : ''}`,
    `Permission: ${result.permissionStatus}`,
    `Formal review events: ${result.formalEventCapability ? 'available' : 'unavailable'}`,
    `Missing fields: ${result.missingFields.join(', ') || 'none'}`,
    `Secret references: ${references}`,
    `Permission probe: ${result.probe.status}`,
    `Repository probe: ${result.probe.repository.status}${result.probe.repository.repository ? ` (${result.probe.repository.repository})` : ''}`,
    `Pull requests permission: ${result.probe.repository.pullRequestPermission}`,
    ...(result.fallbackReason ? [`Reason: ${result.fallbackReason}`] : []),
    `Next action: ${result.nextAction}`,
    result.roleBoundary,
  ].join('\n');
}
