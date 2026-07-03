import type { RepoAffectedCommandResult, RepoInspectCommandResult, RepoPrimePlan } from '../repo/index.js';

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

export function formatRepoInspectHuman(result: RepoInspectCommandResult): string {
  const lines: string[] = [];
  lines.push('aie repo inspect');
  lines.push('');
  lines.push(`Layout: ${result.kind}`);
  lines.push(`Root: ${result.root ?? 'unavailable'}`);
  lines.push(`Remotes: ${result.remotes.length}`);
  lines.push(`Projects: ${result.projects.length}`);
  for (const project of result.projects) {
    lines.push(`  ${project.id}: ${project.path} (${project.kind})`);
  }
  lines.push(`Package managers: ${result.packageManagers.map(manager => `${manager.kind}:${manager.manifestPath}`).join(', ') || 'none'}`);
  lines.push(`CI hints: ${result.ciHints.map(hint => hint.path).join(', ') || 'none'}`);
  lines.push(`Generated paths: ${result.generatedPaths.map(signal => signal.path).join(', ') || 'none'}`);
  lines.push(`Vendor paths: ${result.vendorPaths.map(signal => signal.path).join(', ') || 'none'}`);
  lines.push('');
  lines.push(...formatList('Warnings', [...result.warnings]));
  lines.push('Next commands:');
  lines.push('  aie repo affected --json');
  return lines.join('\n');
}

export function formatRepoAffectedHuman(result: RepoAffectedCommandResult): string {
  const lines: string[] = [];
  lines.push('aie repo affected');
  lines.push('');
  lines.push(`Layout: ${result.layout.kind}`);
  lines.push(`Changed paths: ${result.changedPaths.length}`);
  for (const path of result.changedPaths) lines.push(`  ${path}`);
  lines.push('');
  lines.push('Affected projects:');
  if (result.affectedProjects.length === 0) {
    lines.push('  None.');
  } else {
    for (const affected of result.affectedProjects) {
      lines.push(`  ${affected.project.id}: ${affected.changedPaths.join(', ')} -> ${affected.gates.join(', ')}`);
    }
  }
  lines.push('');
  lines.push(`Suggested gates: ${result.suggestedGates.join(', ') || 'none'}`);
  lines.push('');
  lines.push(...formatList('Warnings', [...result.warnings]));
  return lines.join('\n');
}
