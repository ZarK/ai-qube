import type { DiscoverGitHubAppInstallationsOptions, GitHubAppInstallationCandidate, GitHubAppInstallationDiscoveryConfig, GitHubIssue, GitHubMilestone, GhExec, GhRunResult, GitHubReviewPublisherConfig, ResolvePublisherOptions, ResolvedGitHubReviewPublisher } from '@tjalve/qube-adapter-github';

export type { GitHubIssue, GitHubMilestone, GhExec, GhRunResult };

type GitHubAdapterExports = typeof import('@tjalve/qube-adapter-github');

async function loadGitHubAdapter(): Promise<GitHubAdapterExports> {
  try {
    return await import('@tjalve/qube-adapter-github');
  } catch (error: unknown) {
    if (isModuleMissing(error)) {
      throw new Error([
        'GitHub provider operation requires optional adapter @tjalve/qube-adapter-github.',
        'Install the optional adapter before selecting providers.work.kind=github.',
        'Run qube install --work-provider github --yes --dry-run to review the adapter-backed install plan.',
      ].join(' '));
    }
    throw error;
  }
}

function isModuleMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@tjalve/qube-adapter-github');
}

export async function runGh(args: string[], options: {
  cwd?: string;
  exec?: GhExec;
  token?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<GhRunResult> {
  const adapter = await loadGitHubAdapter();
  return adapter.runGh(args, options);
}

export async function loadPullRequestBody(prNumber: number, options: { cwd?: string; exec?: GhExec } = {}): Promise<string | undefined> {
  // Best-effort read used by dry-run self-checks; a missing body downgrades
  // requirement entries to unmapped guidance instead of failing the command.
  try {
    const result = await runGh(['pr', 'view', String(prNumber), '--json', 'body'], options);
    if (result.exitCode !== 0) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    return parsed !== null && typeof parsed === 'object' && typeof (parsed as { body?: unknown }).body === 'string' ? (parsed as { body: string }).body : undefined;
  } catch {
    return undefined;
  }
}

export async function getIssue(issueNumber: number, options: { cwd?: string; exec?: GhExec; includeAssignees?: boolean } = {}): Promise<GitHubIssue> {
  const adapter = await loadGitHubAdapter();
  return adapter.getIssue(issueNumber, options);
}

export async function listOpenIssues(options: { cwd?: string; exec?: GhExec; limit?: number; includeAssignees?: boolean } = {}): Promise<GitHubIssue[]> {
  const adapter = await loadGitHubAdapter();
  return adapter.listOpenIssues(options);
}

export async function resolveGitHubReviewPublisher(
  config: GitHubReviewPublisherConfig | null | undefined,
  options: ResolvePublisherOptions = {},
): Promise<ResolvedGitHubReviewPublisher> {
  const adapter = await loadGitHubAdapter();
  return adapter.resolveGitHubReviewPublisher(config, options);
}

export async function discoverGitHubAppInstallations(
  config: GitHubAppInstallationDiscoveryConfig,
  options: DiscoverGitHubAppInstallationsOptions = {},
): Promise<readonly GitHubAppInstallationCandidate[]> {
  const adapter = await loadGitHubAdapter();
  return adapter.discoverGitHubAppInstallations(config, options);
}

export type { GitHubAppInstallationCandidate, GitHubAppInstallationDiscoveryConfig, DiscoverGitHubAppInstallationsOptions };

export function isGhExecutionError(error: unknown): error is Error & { stderr?: string; stdout?: string; exitCode?: number; kind?: string } {
  return error instanceof Error && (error.name === 'GhExecutionError' || (error as { kind?: unknown }).kind === 'execution');
}

export function ghFailureMessage(operation: string, exitCode: number, details: string): string {
  return `Failed to execute ${operation}: exit code ${exitCode}. ${details || 'Unknown error'}. Verify gh version and repository state.`;
}
