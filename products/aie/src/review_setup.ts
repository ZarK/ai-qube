import type { Config, GitHubReviewPublisherConfig, GitHubReviewPublisherMode } from './config/index.js';
import type { GitHubReviewPublisherIdentity, ResolvedGitHubReviewPublisher } from '@tjalve/qube-adapter-github';
import { resolveGitHubReviewPublisher } from './providers/github_adapter_exports.js';

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

export interface ReviewPublisherProbe {
  readonly attempted: boolean;
  readonly status: 'ok' | 'degraded' | 'failed' | 'not-run';
  readonly permissionStatus: GitHubReviewPublisherIdentity['permissionStatus'] | null;
  readonly formalEventCapability: boolean | null;
  readonly fallbackReason: string | null;
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

export interface RunReviewDoctorOptions {
  readonly config: Config | null;
  readonly cwd?: string;
  readonly mintProbe?: boolean;
  readonly resolvePublisher?: ReviewPublisherResolver;
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
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
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

function readinessFor(identity: GitHubReviewPublisherIdentity, missingFields: readonly string[], configured: boolean): ReviewPublisherReadiness {
  if (!configured) return 'unconfigured';
  if (missingFields.length > 0 || identity.permissionStatus === 'misconfigured') return 'unavailable';
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
  let identity: GitHubReviewPublisherIdentity;
  try {
    identity = missingFields.length > 0
      ? unavailableIdentity(mode, `Publisher configuration is incomplete: ${missingFields.join(', ')}.`)
      : (await resolver(publisher, { cwd: options.cwd, mint: options.mintProbe === true })).identity;
  } catch (error: unknown) {
    identity = unavailableIdentity(mode, sanitizeReason(error instanceof Error ? error.message : String(error)) ?? 'Publisher resolution failed.');
  }
  identity = { ...identity, fallbackReason: sanitizeReason(identity.fallbackReason) };
  const attempted = configured && missingFields.length === 0 && options.mintProbe === true;
  const readiness = readinessFor(identity, missingFields, configured);
  const probe: ReviewPublisherProbe = {
    attempted,
    status: !attempted ? 'not-run' : readiness === 'ready' ? 'ok' : readiness === 'degraded' ? 'degraded' : 'failed',
    permissionStatus: attempted ? identity.permissionStatus : null,
    formalEventCapability: attempted ? identity.formalEventCapability : null,
    fallbackReason: attempted ? identity.fallbackReason : null,
  };
  return {
    ok: true,
    command: 'review doctor',
    readiness,
    mode,
    identityClass: identity.identityClass,
    login: identity.login,
    permissionStatus: identity.permissionStatus,
    formalEventCapability: identity.formalEventCapability,
    fallbackReason: identity.fallbackReason,
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
    ...(result.fallbackReason ? [`Reason: ${result.fallbackReason}`] : []),
    `Next action: ${result.nextAction}`,
    result.roleBoundary,
  ].join('\n');
}
