import type { ViewIssueResult } from '../view';

export function formatViewHuman(result: ViewIssueResult): string {
  const lines: string[] = [];
  const issue = result.issue;
  lines.push(`#${issue.number} "${issue.title}" (${issue.state})`);
  lines.push(`URL: ${issue.url}`);
  lines.push(`Labels: ${issue.labels.join(', ')}`);
  const metaParts: string[] = [];
  if (issue.priority) metaParts.push(`Priority: ${issue.priority}`);
  if (issue.statusLabel) metaParts.push(`Status: ${issue.statusLabel}`);
  metaParts.push(`Effective: ${issue.effectiveStatus}`);
  if (issue.componentLabels.length > 0) metaParts.push(`Components: ${issue.componentLabels.join(', ')}`);
  lines.push(metaParts.join(' | '));

  if (result.milestone) {
    const milestone = result.milestone;
    let milestoneLine = `Milestone: ${milestone.title} (${milestone.state}`;
    if (milestone.dueOn) milestoneLine += `, due ${milestone.dueOn}`;
    milestoneLine += ')';
    if (milestone.openIssues !== null || milestone.closedIssues !== null) {
      milestoneLine += ` — ${milestone.openIssues ?? 'unknown'} open, ${milestone.closedIssues ?? 'unknown'} closed`;
    }
    lines.push(milestoneLine);
  }

  lines.push('');
  lines.push(result.dependency.blockers.length === 0 ? 'Blockers: None declared.' : 'Blockers:');
  for (const blocker of result.dependency.blockers) {
    lines.push(`  #${blocker.number} "${blocker.title}" (${blocker.state})`);
  }

  lines.push(result.dependency.dependents.length === 0 ? 'Dependents: None.' : 'Dependents:');
  for (const dependent of result.dependency.dependents) {
    lines.push(`  #${dependent.number} "${dependent.title}" (${dependent.state})`);
  }

  if (result.checklist.total > 0) {
    lines.push(`Checklist: ${result.checklist.checked}/${result.checklist.total} checked`);
    for (const item of result.checklist.items) {
      lines.push(`  - ${item}`);
    }
  }

  lines.push('');
  lines.push(`Branch: ${result.branch.suggested}`);
  if (result.branch.current !== null) {
    lines.push(`Current: ${result.branch.current} (${result.branch.matches ? 'matches' : 'does not match'})`);
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings: ${result.warnings.join(' ')}`);
  }

  lines.push('');
  lines.push(`Next action: ${result.recommendedAction}`);

  return lines.join('\n');
}
