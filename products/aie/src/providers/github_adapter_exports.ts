import type { GitHubIssue, GitHubMilestone, GhExec, GhRunResult } from '@tjalve/qube-adapter-github';

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

export async function runGh(args: string[], options: { cwd?: string; exec?: GhExec } = {}): Promise<GhRunResult> {
  const adapter = await loadGitHubAdapter();
  return adapter.runGh(args, options);
}

export async function getIssue(issueNumber: number, options: { cwd?: string; exec?: GhExec; includeAssignees?: boolean } = {}): Promise<GitHubIssue> {
  const adapter = await loadGitHubAdapter();
  return adapter.getIssue(issueNumber, options);
}

export async function listOpenIssues(options: { cwd?: string; exec?: GhExec; limit?: number; includeAssignees?: boolean } = {}): Promise<GitHubIssue[]> {
  const adapter = await loadGitHubAdapter();
  return adapter.listOpenIssues(options);
}

export function isGhExecutionError(error: unknown): error is Error & { stderr?: string; stdout?: string; exitCode?: number; kind?: string } {
  return error instanceof Error && (error.name === 'GhExecutionError' || (error as { kind?: unknown }).kind === 'execution');
}

export function ghFailureMessage(operation: string, exitCode: number, details: string): string {
  return `Failed to execute ${operation}: exit code ${exitCode}. ${details || 'Unknown error'}. Verify gh version and repository state.`;
}
