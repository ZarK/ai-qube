import type { CompleteResult } from '../complete';
import type { StartResult } from '../start';
import type { SwitchResult } from '../switch';

function getStringArray(details: Record<string, unknown>, key: string): string[] {
  const value = details[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}

function formatStartActionList(result: StartResult, kind: string): string {
  const actions = result.plan.actions.filter(action => action.kind === kind);
  if (actions.length === 0) return 'not planned';
  return actions.map(action => {
    if (action.kind !== 'replace-status-labels') return action.status;
    const addLabels = getStringArray(action.details, 'addLabels');
    const removeLabels = getStringArray(action.details, 'removeLabels');
    const labelChanges = [
      ...addLabels.map(label => `+${label}`),
      ...removeLabels.map(label => `-${label}`),
    ];
    return labelChanges.length > 0 ? `${action.status} (${labelChanges.join(', ')})` : action.status;
  }).join(', ');
}

function formatSwitchActionList(result: SwitchResult, kind: string, issueNumber?: number): string {
  const actions = result.plan.actions.filter(action => action.kind === kind && (issueNumber === undefined || action.targetId === String(issueNumber)));
  if (actions.length === 0) return 'not planned';
  return actions.map(action => {
    if (action.kind !== 'replace-status-labels') return action.status;
    const addLabels = getStringArray(action.details, 'addLabels');
    const removeLabels = getStringArray(action.details, 'removeLabels');
    const labelChanges = [
      ...addLabels.map(label => `+${label}`),
      ...removeLabels.map(label => `-${label}`),
    ];
    return labelChanges.length > 0 ? `${action.status} (${labelChanges.join(', ')})` : action.status;
  }).join(', ');
}

function formatCompleteLabels(result: CompleteResult, issueNumber: number): string {
  const actions = result.plan.actions.filter(action =>
    (action.kind === 'replace-status-labels' || action.kind === 'refresh-dependent-status') &&
    action.targetId === String(issueNumber),
  );
  if (actions.length === 0) return 'not planned';
  return actions.map(action => {
    const changes = [
      ...getStringArray(action.details, 'addLabels').map(label => `+${label}`),
      ...getStringArray(action.details, 'removeLabels').map(label => `-${label}`),
    ];
    return changes.length > 0 ? `${action.status} (${changes.join(', ')})` : action.status;
  }).join(', ');
}

function formatCompleteClose(result: CompleteResult): string {
  const action = result.plan.actions.find(item => item.kind === 'close-issue');
  if (!action) return result.completion.alreadyClosed ? 'already closed' : 'not planned';
  return action.status;
}

export function formatStartHuman(result: StartResult): string {
  const lines: string[] = [];
  const mode = result.dryRun ? ' (dry-run)' : '';
  lines.push(`aie start${mode}: ${result.action.toUpperCase()}`);
  lines.push(`Reason: ${result.reason}`);
  if (result.issue) {
    lines.push(`Issue: #${result.issue.number} "${result.issue.title}" (${result.issue.state})`);
  }
  if (result.blockers.length > 0) {
    lines.push(`Blockers: ${result.blockers.map(number => `#${number}`).join(', ')}`);
  }
  lines.push(`Active issues: ${result.activeIssueState.inProgressCount}`);
  if (result.preStartPolicy) {
    lines.push(`Pre-start policy: ${result.preStartPolicy.ok ? 'passed' : 'blocked'}${result.preStartPolicy.bypassed ? ' (resume bypass)' : ''}`);
    for (const blocker of result.preStartPolicy.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }
  if (result.branchRecommendation.suggested) {
    lines.push(`Branch: ${result.branchRecommendation.suggested}`);
  }
  lines.push(`Labels: ${formatStartActionList(result, 'replace-status-labels')}`);
  lines.push(`Assignment: ${formatStartActionList(result, 'assign-issue')}`);
  lines.push(`Comment: ${formatStartActionList(result, 'add-comment')}`);
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join(' ')}`);
  }
  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.join(' ')}`);
  }
  lines.push(`Next: ${result.branchRecommendation.nextCommand}`);
  return lines.join('\n');
}

export function formatSwitchHuman(result: SwitchResult): string {
  const lines: string[] = [];
  const mode = result.dryRun ? ' (dry-run)' : '';
  lines.push(`aie switch${mode}: ${result.action.toUpperCase()}`);
  lines.push(`Reason: ${result.reason}`);
  if (result.sourceIssue) {
    lines.push(`Source issue: #${result.sourceIssue.number} "${result.sourceIssue.title}" (${result.sourceIssue.state})`);
  }
  if (result.targetIssue) {
    lines.push(`Target issue: #${result.targetIssue.number} "${result.targetIssue.title}" (${result.targetIssue.state})`);
  }
  if (result.blockers.length > 0) {
    lines.push(`Blockers: ${result.blockers.map(number => `#${number}`).join(', ')}`);
  }
  lines.push(`Active issues: ${result.activeIssueState.inProgressCount}`);
  if (result.preStartPolicy) {
    lines.push(`Pre-start policy: ${result.preStartPolicy.ok ? 'passed' : 'blocked'}${result.preStartPolicy.bypassed ? ' (resume bypass)' : ''}`);
    for (const blocker of result.preStartPolicy.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }
  if (result.branchRecommendation.suggested) {
    lines.push(`Branch: ${result.branchRecommendation.suggested}`);
  }
  lines.push(`Source labels: ${formatSwitchActionList(result, 'replace-status-labels', result.sourceIssue?.number)}`);
  lines.push(`Target labels: ${formatSwitchActionList(result, 'replace-status-labels', result.targetIssue?.number)}`);
  lines.push(`Assignment: ${formatSwitchActionList(result, 'assign-issue')}`);
  lines.push(`Comment: ${formatSwitchActionList(result, 'add-comment')}`);
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join(' ')}`);
  }
  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.join(' ')}`);
  }
  lines.push(`Next: ${result.branchRecommendation.nextCommand}`);
  return lines.join('\n');
}

export function formatCompleteHuman(result: CompleteResult): string {
  const mode = result.checkOnly ? ' (check-only)' : result.dryRun ? ' (dry-run)' : '';
  const lines: string[] = [];
  lines.push(`aie complete${mode}: ${result.action.toUpperCase()}`);
  lines.push(`Reason: ${result.reason}`);
  lines.push(`Issue: #${result.issue.number} "${result.issue.title}" (${result.issue.state})`);
  lines.push(`Checklist: ${result.checklist.checked}/${result.checklist.total} checked`);
  lines.push(`Status labels: ${formatCompleteLabels(result, result.issue.number)}`);
  lines.push(`Close: ${formatCompleteClose(result)}`);
  if (result.dependentRefresh.dependents.length > 0) {
    lines.push('Dependents:');
    for (const dependent of result.dependentRefresh.dependents) {
      const blockers = dependent.openBlockers.length > 0 ? `; open blockers ${dependent.openBlockers.map(number => `#${number}`).join(', ')}` : '';
      lines.push(`  #${dependent.issue.number}: ${dependent.status}; labels ${formatCompleteLabels(result, dependent.issue.number)}${blockers}`);
    }
  } else {
    lines.push('Dependents: none');
  }
  if (result.milestoneContext) {
    const remaining = result.milestoneContext.remainingOpenIssues === null ? 'unknown' : String(result.milestoneContext.remainingOpenIssues);
    lines.push(`Milestone: ${result.milestoneContext.title}; remaining open issues after completion: ${remaining}`);
  }
  if (result.plan.summary.failedCount > 0 || result.plan.summary.skippedCount > 0) {
    lines.push(`Actions: completed=${result.plan.summary.completedCount}, failed=${result.plan.summary.failedCount}, skipped=${result.plan.summary.skippedCount}`);
  }
  if (result.warnings.length > 0) lines.push(`Warnings: ${result.warnings.join(' ')}`);
  if (result.errors.length > 0) lines.push(`Errors: ${result.errors.join(' ')}`);
  lines.push(`Next: ${result.nextCommand}`);
  return lines.join('\n');
}
