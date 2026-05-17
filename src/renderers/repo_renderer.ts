import type { RepoPrimePlan } from '../repo';

function formatList(title: string, values: string[]): string[] {
  if (values.length === 0) return [`${title}:`, '  None.', ''];
  return [`${title}:`, ...values.map(value => `  ${value}`), ''];
}

export function formatRepoPrimeHuman(plan: RepoPrimePlan, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(`aie repo prime${dryRun ? ' (dry-run)' : ''}`);
  lines.push('');
  lines.push('Checks:');
  lines.push(`  Repository: ${plan.repository ? `${plan.repository.nameWithOwner} (${plan.repository.url})` : 'unavailable'}`);
  lines.push(`  Config: ${plan.configPresent ? 'present' : 'missing'} (${plan.configPath})`);
  lines.push(`  Labels: ${plan.labelPlan ? `created=${plan.labelPlan.created.length}, updated=${plan.labelPlan.updated.length}, unchanged=${plan.labelPlan.unchanged.length}` : 'unavailable'}`);
  lines.push(`  Open issues: ${plan.openIssueCount ?? 'unavailable'}`);
  lines.push(`  Worktree: ${plan.worktree.isWorktree ? 'linked worktree' : 'primary checkout'}`);
  lines.push(`  Base ref: ${plan.baseRef.remote}/${plan.baseRef.branch} ${plan.baseRef.resolved ? 'resolved' : 'unresolved'}`);
  lines.push(`  Open PRs: ${plan.pullRequests.length} (${plan.blockingPullRequests.length} blocking)`);
  lines.push(`  Milestones: ${plan.milestones.length}; issues without milestones: ${plan.milestoneWarnings.length}`);
  lines.push(`  Instructions: AGENTS.md=${plan.instructions.agents ? 'yes' : 'no'}, CLAUDE.md=${plan.instructions.claude ? 'yes' : 'no'}, make-it-so=${plan.instructions.opencodeMakeItSo ? 'yes' : 'no'}`);
  lines.push(`  Planning artifacts: spec=${plan.planning.spec ? 'yes' : 'no'}, milestone docs=${plan.planning.milestones.length}`);
  lines.push('');
  lines.push(...formatList('Planned changes', plan.plannedChanges));
  lines.push(...formatList('Completed changes', plan.completedChanges));
  lines.push(...formatList('Skipped actions', plan.skippedActions));
  lines.push(...formatList('Warnings', plan.warnings));
  lines.push('Next commands:');
  lines.push('  aie labels setup --dry-run');
  lines.push('  aie queue --json');
  lines.push('  aie doctor --json');
  return lines.join('\n');
}
