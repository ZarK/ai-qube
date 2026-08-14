import { execFileSync } from 'node:child_process';
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
  readonly ownerAvatarUrl?: string | null;
}

export interface ReviewRepositoryProbe extends ReviewRepositoryProbeResult {
  readonly attempted: boolean;
  readonly status: 'ok' | 'degraded' | 'failed' | 'not-run';
}

export type ReviewAvatarProbeStatus = 'ok' | 'warning' | 'unknown' | 'not-run';

export interface ReviewAvatarProbe {
  readonly attempted: boolean;
  readonly status: ReviewAvatarProbeStatus;
  readonly botAvatarUrl: string | null;
  readonly ownerAvatarUrl: string | null;
  readonly ownerFallback: boolean | null;
}

export interface ReviewAvatarObservation {
  readonly botAvatarUrl: string | null;
  readonly ownerAvatarUrl: string | null;
}

export interface ReviewPublisherProbe {
  readonly attempted: boolean;
  readonly status: 'ok' | 'degraded' | 'failed' | 'not-run';
  readonly permissionStatus: GitHubReviewPublisherIdentity['permissionStatus'] | null;
  readonly formalEventCapability: boolean | null;
  readonly fallbackReason: string | null;
  readonly repository: ReviewRepositoryProbe;
  readonly avatar: ReviewAvatarProbe;
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
  options?: {
    readonly cwd?: string;
    readonly mint?: boolean;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
) => Promise<ResolvedGitHubReviewPublisher>;

export type ReviewRepositoryAccessProber = (options: {
  readonly cwd?: string;
  readonly accessToken: string | null;
  readonly identity: GitHubReviewPublisherIdentity;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}) => Promise<ReviewRepositoryProbeResult>;

export type ReviewAvatarProber = (options: {
  readonly cwd?: string;
  readonly accessToken: string | null;
  readonly identity: GitHubReviewPublisherIdentity;
  readonly repository: string | null;
  readonly ownerAvatarUrl: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}) => Promise<ReviewAvatarObservation>;

export interface RunReviewDoctorOptions {
  readonly config: Config | null;
  readonly cwd?: string;
  readonly mintProbe?: boolean;
  /** Override probe deadline (ms). Defaults to REVIEW_DOCTOR_PROBE_TIMEOUT_MS. Injectable for tests. */
  readonly probeTimeoutMs?: number;
  readonly resolvePublisher?: ReviewPublisherResolver;
  readonly probeRepositoryAccess?: ReviewRepositoryAccessProber;
  readonly probePublisherAvatar?: ReviewAvatarProber;
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
      'Generate a private key and keep it outside repository files. Prefer an environment variable name containing the PEM; use a local filesystem path only when an environment variable is not practical.',
      'Find the installation id in the GitHub App installation URL or with `gh api /app/installations` while authenticated as the app owner.',
      'Upload a distinct app logo and matching badge color in the GitHub App display settings. Do not rename the app; a rename can change the slug and `[bot]` login.',
      'Apply local config with `review setup github-app --app-id <id> --installation-id <id> --private-key-env <ENV_NAME> --yes` (prefer --private-key-env over --private-key-path).',
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
    credentialVerified: false,
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

function parseGitHubRemoteRepository(remote: string): string | null {
  const trimmed = remote.trim();
  // Accept HTTPS and SSH remotes; strip only a terminal .git suffix so dotted repo names work.
  const match = trimmed.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  const owner = match[1]?.trim();
  const repo = match[2]?.trim();
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

async function probeCurrentRepositoryAccess(options: {
  readonly cwd?: string;
  readonly accessToken: string | null;
  readonly identity: GitHubReviewPublisherIdentity;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ReviewRepositoryProbeResult> {
  if (!options.accessToken) {
    return {
      repository: null,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: 'Configured publisher credential did not yield an access token for the current-repository probe.',
    };
  }
  const limits = { signal: options.signal, timeoutMs: options.timeoutMs };
  // Prefer local origin first to avoid an extra provider round-trip when possible.
  let repository: string | null = null;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    repository = parseGitHubRemoteRepository(remote);
  } catch {
    repository = null;
  }
  if (!repository) {
    // Fall back to publisher-credentialed discovery when local remote is unavailable.
    try {
      const repositoryResult = await runGh(['repo', 'view', '--json', 'nameWithOwner'], {
        cwd: options.cwd,
        token: options.accessToken,
        ...limits,
      });
      repository = repositoryResult.exitCode === 0 ? parseRepositoryName(repositoryResult.stdout) : null;
    } catch {
      repository = null;
    }
  }
  if (!repository) {
    return {
      repository: null,
      accessible: false,
      pullRequestPermission: 'unknown',
      fallbackReason: 'Could not detect the current GitHub repository using the publisher credential or local git remote.',
    };
  }
  const accessResult = await runGh([
    'api',
    `repos/${repository}`,
    '--include',
    '-H',
    'Accept: application/vnd.github+json',
  ], { cwd: options.cwd, token: options.accessToken, ...limits });
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
    ownerAvatarUrl: parseOwnerAvatarUrl(repositoryBody),
    fallbackReason: pullRequestPermission === 'write'
      ? null
      : `Configured publisher can read ${repository} but Pull requests write permission was not confirmed.`,
  };
}

export function normalizeReviewAvatarUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

function parseOwnerAvatarUrl(body: Record<string, unknown>): string | null {
  const owner = body.owner;
  if (!isRecord(owner) || typeof owner.avatar_url !== 'string') return null;
  return owner.avatar_url;
}

function parseUserAvatarUrl(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) && typeof parsed.avatar_url === 'string' ? parsed.avatar_url : null;
  } catch {
    const body = parseRepositoryBody(stdout);
    return body && typeof body.avatar_url === 'string' ? body.avatar_url : null;
  }
}

function notRunAvatarProbe(): ReviewAvatarProbe {
  return {
    attempted: false,
    status: 'not-run',
    botAvatarUrl: null,
    ownerAvatarUrl: null,
    ownerFallback: null,
  };
}

function avatarProbeFrom(observation: ReviewAvatarObservation): ReviewAvatarProbe {
  const botAvatarUrl = normalizeReviewAvatarUrl(observation.botAvatarUrl);
  const ownerAvatarUrl = normalizeReviewAvatarUrl(observation.ownerAvatarUrl);
  if (!botAvatarUrl || !ownerAvatarUrl) {
    return {
      attempted: true,
      status: 'unknown',
      botAvatarUrl,
      ownerAvatarUrl,
      ownerFallback: null,
    };
  }
  const ownerFallback = botAvatarUrl === ownerAvatarUrl;
  return {
    attempted: true,
    status: ownerFallback ? 'warning' : 'ok',
    botAvatarUrl,
    ownerAvatarUrl,
    ownerFallback,
  };
}

async function probePublisherAvatar(options: {
  readonly cwd?: string;
  readonly accessToken: string | null;
  readonly identity: GitHubReviewPublisherIdentity;
  readonly repository: string | null;
  readonly ownerAvatarUrl: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ReviewAvatarObservation> {
  let ownerAvatarUrl = options.ownerAvatarUrl;
  const limits = { signal: options.signal, timeoutMs: options.timeoutMs };
  if (!ownerAvatarUrl && options.repository && options.accessToken) {
    const accessResult = await runGh([
      'api',
      `repos/${options.repository}`,
      '-H',
      'Accept: application/vnd.github+json',
    ], { cwd: options.cwd, token: options.accessToken, ...limits });
    if (accessResult.exitCode === 0) {
      const body = parseRepositoryBody(accessResult.stdout) ?? (() => {
        try {
          const parsed = JSON.parse(accessResult.stdout) as unknown;
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      })();
      ownerAvatarUrl = body ? parseOwnerAvatarUrl(body) : null;
    }
  }
  let botAvatarUrl: string | null = null;
  if (options.accessToken && options.identity.login) {
    const userResult = await runGh([
      'api',
      `users/${encodeURIComponent(options.identity.login)}`,
      '-H',
      'Accept: application/vnd.github+json',
    ], { cwd: options.cwd, token: options.accessToken, ...limits });
    if (userResult.exitCode === 0) botAvatarUrl = parseUserAvatarUrl(userResult.stdout);
  }
  return { botAvatarUrl, ownerAvatarUrl };
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
    ownerAvatarUrl: result.ownerAvatarUrl ?? null,
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
  if (identity.permissionStatus === 'missing' && identity.identityClass === 'none') return 'unavailable';
  // Ready only when identity is ok and the repository probe proved pull-request write.
  if (
    identity.permissionStatus === 'ok'
    && identity.formalEventCapability
    && repository.attempted
    && repository.accessible
    && repository.pullRequestPermission === 'write'
  ) {
    return 'ready';
  }
  // Unknown repository PR permission is degraded, not missing.
  return 'degraded';
}

function nextActionFor(readiness: ReviewPublisherReadiness, mode: GitHubReviewPublisherMode, missingFields: readonly string[], probe: ReviewPublisherProbe): string {
  if (readiness === 'unconfigured') return 'Run `qube review setup github-app` (preferred) or `qube review setup token` (fallback).';
  if (missingFields.length > 0) return `Re-run \`qube review setup ${mode}\` with ${missingFields.join(' and ')}, then add --yes to apply the safe references.`;
  if (!probe.attempted) return 'Run `qube review doctor --json` without --no-probe after the referenced credential is available locally.';
  if (readiness === 'ready' && probe.avatar.status === 'warning') {
    return 'Upload a distinct logo in the GitHub App display settings (PNG, JPG, or GIF under 1 MB; 200x200 px recommended) and set the badge background to match. Do not rename the app. Then rerun `qube review doctor --json`.';
  }
  if (readiness === 'ready' && probe.avatar.status === 'unknown') {
    return 'Publisher permissions are ready, but the github-app avatar could not be compared with the repository owner avatar. Confirm the app logo in GitHub App display settings, then rerun `qube review doctor --json`.';
  }
  if (readiness === 'ready') return 'Publisher is ready. Continue using host-run review agents/subagents and publish their results through the configured provider identity.';
  if (probe.permissionStatus === 'same-author') return 'Use a GitHub App installation or token owned by an identity different from the pull request author.';
  // Credential resolution failures take priority over repository-access messaging.
  if (
    !probe.repository.attempted
    && (probe.permissionStatus === 'missing' || probe.permissionStatus === 'misconfigured')
  ) {
    if (probe.fallbackReason) {
      return `${probe.fallbackReason} Fix the configured ${mode} credential reference, then rerun \`qube review doctor --json\`.`;
    }
    return mode === 'github-app'
      ? 'Grant the installed GitHub App Pull requests read/write permission, refresh the installation, and rerun `qube review doctor --json`.'
      : 'Grant the fine-grained token Pull requests read/write access to the repository, then rerun `qube review doctor --json`.';
  }
  if (probe.repository.attempted && !probe.repository.accessible) return `Grant the configured publisher access to the current repository${probe.repository.repository ? ` ${probe.repository.repository}` : ''}, then rerun \`qube review doctor --json\`.`;
  if (probe.repository.attempted && probe.repository.pullRequestPermission === 'read') {
    return 'Grant the configured publisher Pull requests read/write permission for the current repository, then rerun `qube review doctor --json`.';
  }
  if (probe.repository.attempted && probe.repository.pullRequestPermission === 'unknown') {
    return mode === 'token'
      ? 'Repository access succeeded, but fine-grained token Pull requests write could not be proven from a read-only probe. Confirm the token has Pull requests read/write on this repository, then rerun `qube review doctor --json` or continue with host-run publish and inspect the provider result.'
      : 'Repository access succeeded, but pull-request write capability could not be proven. Confirm the GitHub App installation has Pull requests read/write, then rerun `qube review doctor --json`.';
  }
  if (probe.permissionStatus === 'missing') return mode === 'github-app'
    ? 'Grant the installed GitHub App Pull requests read/write permission, refresh the installation, and rerun `qube review doctor --json`.'
    : 'Grant the fine-grained token Pull requests read/write access to the repository, then rerun `qube review doctor --json`.';
  return `Verify the configured ${mode} credential reference and repository access, then rerun \`qube review doctor --json\`.`;
}

/** Bounded deadline for live publisher identity and repository probes. */
export const REVIEW_DOCTOR_PROBE_TIMEOUT_MS = 20_000;

async function withProbeTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs = REVIEW_DOCTOR_PROBE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms. Rerun with network available or use --no-probe for offline reference checks.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runReviewDoctor(options: RunReviewDoctorOptions): Promise<ReviewDoctorResult> {
  const publisher = options.config?.providers.review.publisher;
  const mode = publisher?.mode ?? 'user';
  const configured = Boolean(publisher && mode !== 'user');
  const missingFields = publisherMissingFields(publisher);
  const resolver = options.resolvePublisher ?? resolveGitHubReviewPublisher;
  const repositoryProber = options.probeRepositoryAccess ?? probeCurrentRepositoryAccess;
  const avatarProber = options.probePublisherAvatar ?? probePublisherAvatar;
  const probeTimeoutMs = options.probeTimeoutMs ?? REVIEW_DOCTOR_PROBE_TIMEOUT_MS;
  let resolved: ResolvedGitHubReviewPublisher | null = null;
  let identity: GitHubReviewPublisherIdentity;
  try {
    if (!configured) {
      // Default user publisher is unconfigured for distinct review publishing.
      // Do not mint or call live identity endpoints for this no-op readiness path.
      identity = {
        mode: 'user',
        identityClass: 'user',
        login: null,
        permissionStatus: 'unconfigured',
        formalEventCapability: false,
        credentialVerified: false,
        fallbackReason: 'No distinct reviewer identity is configured; publishing uses the authenticated gh user.',
        publishTransport: 'pull-request-review',
        authSource: 'gh-user',
      };
    } else if (missingFields.length > 0) {
      identity = unavailableIdentity(mode, `Publisher configuration is incomplete: ${missingFields.join(', ')}.`);
    } else {
      resolved = await withProbeTimeout(
        (signal) => resolver(publisher, {
          cwd: options.cwd,
          mint: options.mintProbe === true,
          signal,
          timeoutMs: probeTimeoutMs,
        }),
        'Publisher identity probe',
        probeTimeoutMs,
      );
      identity = resolved.identity;
    }
  } catch (error: unknown) {
    identity = unavailableIdentity(mode, sanitizeReason(error instanceof Error ? error.message : String(error)) ?? 'Publisher resolution failed.');
  }
  identity = { ...identity, fallbackReason: sanitizeReason(identity.fallbackReason) };
  const attempted = configured && missingFields.length === 0 && options.mintProbe === true;
  let repository = notRunRepositoryProbe();
  // Skip repository probing when identity resolution failed or no access token is available
  // (missing credential env/key must not be reported as a repository-access problem).
  const canProbeRepository = Boolean(resolved?.accessToken);
  if (attempted && canProbeRepository && resolved) {
    try {
      repository = repositoryProbe(await withProbeTimeout(
        (signal) => repositoryProber({
          cwd: options.cwd,
          accessToken: resolved.accessToken ?? null,
          identity,
          signal,
          timeoutMs: probeTimeoutMs,
        }),
        'Current-repository access probe',
        probeTimeoutMs,
      ));
    } catch (error: unknown) {
      repository = repositoryProbe({
        repository: null,
        accessible: false,
        pullRequestPermission: 'unknown',
        fallbackReason: sanitizeReason(error instanceof Error ? error.message : String(error)) ?? 'Current-repository access probe failed.',
      });
    }
  }
  let avatar = notRunAvatarProbe();
  if (attempted && mode === 'github-app' && canProbeRepository && resolved) {
    try {
      avatar = avatarProbeFrom(await withProbeTimeout(
        (signal) => avatarProber({
          cwd: options.cwd,
          accessToken: resolved.accessToken ?? null,
          identity,
          repository: repository.repository,
          ownerAvatarUrl: repository.ownerAvatarUrl ?? null,
          signal,
          timeoutMs: probeTimeoutMs,
        }),
        'Publisher avatar probe',
        probeTimeoutMs,
      ));
    } catch {
      avatar = avatarProbeFrom({ botAvatarUrl: null, ownerAvatarUrl: repository.ownerAvatarUrl ?? null });
    }
  }
  const readiness = readinessFor(identity, missingFields, configured, repository);
  // Do not coerce unobservable fine-grained-token PR permission (unknown) into missing.
  const effectivePermissionStatus = identity.permissionStatus === 'same-author'
    ? 'same-author'
    : repository.attempted && !repository.accessible
      ? 'missing'
      : repository.attempted && repository.pullRequestPermission === 'read'
        ? 'missing'
        : repository.attempted && repository.pullRequestPermission === 'unknown' && identity.permissionStatus === 'ok'
          ? 'unknown'
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
    avatar,
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
    `Avatar probe: ${result.probe.avatar.status}`,
    ...(result.fallbackReason ? [`Reason: ${result.fallbackReason}`] : []),
    `Next action: ${result.nextAction}`,
    result.roleBoundary,
  ].join('\n');
}
