import { BranchResult, parseBranchIssueNumber } from './branch';

export function usage(command: string, examples: string[]): string {
  return [`Usage: aie ${command} <issue>`, '', 'Examples:', ...examples.map(example => `  ${example}`)].join('\n');
}

export function shouldShowBranchHelp(input: string | undefined): boolean {
  return !input || input === 'help' || input === '--help' || input === '-h';
}

export function usageJson(commandName: string, examples: string[]): { ok: boolean; command: string; usage: string; examples: string[] } {
  return { ok: true, command: commandName, usage: `aie ${commandName} <issue>`, examples };
}

export function parseBranchIssue(input: string): number {
  return parseBranchIssueNumber(input);
}

export function formatBranchResult(result: BranchResult): string {
  const lines = [`aie ${result.command}${result.dryRun ? ' (dry-run)' : ''}: ${result.ok ? 'OK' : 'BLOCKED'}`];
  lines.push(`Issue: #${result.issue.number} "${result.issue.title}" (${result.issue.state})`);
  lines.push(`Suggested branch: ${result.branch.suggested}`);
  lines.push(`Current branch: ${result.branch.current ?? 'none'}`);
  lines.push(`Matches policy: ${result.branch.matches ? 'yes' : 'no'}`);
  if (result.command === 'branch create') {
    lines.push(`Repository: ${result.branch.repoRoot ?? 'not found'}`);
    lines.push(`Worktree: ${result.branch.worktree.isWorktree ? 'linked worktree' : 'primary checkout'}`);
    lines.push(`Dirty checkout: ${result.branch.dirty.dirty ? 'yes' : 'no'}`);
    lines.push(`Base ref: ${result.branch.baseRef.remote}/${result.branch.baseRef.branch} ${result.branch.baseRef.resolved && result.branch.baseRef.upToDate ? 'current' : 'not current'}`);
  }
  lines.push(`Actions: ${result.plan.actions.map(action => `${action.status} ${action.description}`).join('; ')}`);
  if (result.errors.length > 0) lines.push(`Errors: ${result.errors.join(' ')}`);
  lines.push(`Next: ${result.nextAction}`);
  return lines.join('\n');
}

export function branchCommandError(command: string, input: string | undefined, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Failed to run \`aie ${command}\`. Likely cause: ${detail}. Next action: run \`aie ${command} ${input ?? '<issue>'} --help\` or verify the issue number and repository state.`;
}
