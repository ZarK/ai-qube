import { relative } from 'path';
import { getKnownLegacyScript } from './legacy';
import type { MigrationPlan } from './migrate';

export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines = [
    'Legacy migration plan',
    `Repository: ${plan.repoRoot ? relative(process.cwd(), plan.repoRoot) || '.' : 'not found'}`,
    `Mode: ${plan.mode}${plan.dryRun ? ' (dry run)' : plan.apply ? ' (apply)' : ' (audit only)'}`,
    `Detected paths: ${plan.inventory.length}`,
    `Planned file replacements: ${plan.plannedFileChanges.length}`,
    `Instruction updates: ${plan.instructionUpdates.length}`,
    `Cleanup candidates: ${plan.cleanupCandidates.length}`,
    `Review-required preserves: ${plan.skippedFiles.filter(item => item.confidence === 'review-required').length}`,
  ];
  if (plan.inventory.length > 0) {
    lines.push('', 'Inventory:');
    for (const item of plan.inventory) {
      lines.push(`- ${item.path}: ${item.category}, ${item.confidence}, plan=${item.proposedAction}`);
    }
  }
  lines.push('', 'Wrapper installs:');
  if (plan.wrapperInstalls.length === 0) lines.push('- none');
  for (const item of plan.wrapperInstalls) lines.push(`- ${item.path}: delegates to ${getKnownLegacyScript(item.path)?.replacementCommand ?? 'aie'}`);

  lines.push('', 'Cleanup decisions:');
  const cleanupRemovals = new Set(plan.cleanupCandidates.map(item => item.path));
  if (plan.cleanupCandidates.length === 0 && plan.skippedFiles.length === 0) lines.push('- none');
  for (const item of plan.cleanupCandidates) lines.push(`- ${item.path}: remove, ${item.reason}`);
  for (const item of plan.skippedFiles.filter(item => !cleanupRemovals.has(item.path))) lines.push(`- ${item.path}: preserve, ${item.reason}`);

  lines.push('', 'Instruction updates:');
  if (plan.instructionUpdates.length === 0) lines.push('- none');
  for (const update of plan.instructionUpdates) {
    const replacementText = update.replacements.length === 0
      ? 'no known helper references'
      : update.replacements.map(replacement => `${replacement.legacyReference} -> ${replacement.executorCommand} (${replacement.occurrences})`).join('; ');
    lines.push(`- ${update.path}: ${update.status}, ${update.operation}, ${replacementText}. ${update.reason}`);
  }

  lines.push('', 'Completed changes:');
  if (plan.completedChanges.length === 0) lines.push('- none');
  for (const change of plan.completedChanges) lines.push(`- ${change}`);

  lines.push('', 'Skipped files:');
  if (plan.skippedFiles.length === 0) lines.push('- none');
  for (const item of plan.skippedFiles) lines.push(`- ${item.path}: ${item.confidence}, ${item.reason}`);

  lines.push('', 'Required confirmations:');
  if (plan.confirmations.length === 0) lines.push('- none');
  for (const confirmation of plan.confirmations) lines.push(`- ${confirmation.path}: ${confirmation.requiredFor}, ${confirmation.reason}`);

  lines.push('', 'Preservation: GitHub labels, blocker metadata, sequence metadata, milestone assignments, active issue state, branch state, git history, and GitHub state are preserved.');
  if (plan.conflicts.length > 0) {
    lines.push('', 'Conflicts requiring review:');
    for (const conflict of plan.conflicts) lines.push(`- ${conflict.path}: ${conflict.reason}`);
  }
  if (plan.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  lines.push('', `Next action: ${plan.nextCommand}`);
  return lines.join('\n');
}
