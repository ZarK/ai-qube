import type { InitResult } from '../init/index.js';

function formatList(title: string, values: string[]): string[] {
  if (values.length === 0) return [`${title}: none`];
  return [`${title}:`, ...values.map(value => `  ${value}`)];
}

export function formatInitHuman(result: InitResult): string {
  const mode = result.dryRun ? ' (dry-run)' : '';
  const lines: string[] = [];
  lines.push(`aie init${mode}: ${result.ok ? 'OK' : 'BLOCKED'}`);
  lines.push(`Target: ${result.target}`);
  lines.push(`Repository: ${result.repoRoot ?? 'not detected'}`);
  lines.push(`Tools: ${result.selectedTools.length > 0 ? result.selectedTools.join(', ') : 'none'}`);
  lines.push(`Policy: naming rules ${result.policy.namingRules ? 'enabled' : 'disabled'}, milestone ordering ${result.policy.milestoneOrdering ? 'enabled' : 'disabled'}, supply-chain safety ${result.policy.supplyChainSafety ? 'enabled' : 'disabled'}`);
  lines.push(`Config: ${result.configPath}`);
  if (result.setupSummary) {
    lines.push(`Setup: review mode ${result.setupSummary.reviewMode}, publisher ${result.setupSummary.publisher}, reviewers ${result.setupSummary.reviewers.join(', ') || 'none'}, quality control ${result.setupSummary.qualityControl ? 'enabled' : 'disabled'}, UI audit ${result.setupSummary.manualUiAudit ? 'enabled' : 'disabled'}`);
  }
  if (result.from) {
    lines.push(`Adopted from: ${result.from.source} (${result.from.kind})`);
    lines.push(...formatList('Adjustments', result.from.adjustments));
  }
  if (result.questions.length > 0) {
    lines.push(result.awaitingAnswers ? 'Questions:' : 'Answered questions:');
    for (const item of result.questions) {
      const state = item.answered ? `answered=${String(item.value)}` : `recommended=${String(item.recommendedValue)}`;
      lines.push(`  ${item.id}: ${item.prompt} (${state})`);
      lines.push(`    ${item.recommendation}`);
    }
  }
  lines.push('Actions:');
  if (result.actions.length === 0) lines.push('  None.');
  for (const action of result.actions) {
    const conflict = action.conflict ? '; conflict' : '';
    lines.push(`  ${action.status} ${action.path} (${action.operation}${conflict}) — ${action.reason}`);
  }
  lines.push(...formatList('Planned changes', result.plannedChanges));
  lines.push(...formatList('Completed changes', result.completedChanges));
  lines.push(...formatList('Skipped actions', result.skippedActions));
  lines.push(...formatList('Warnings', result.warnings));
  lines.push(...formatList('Errors', result.errors));
  lines.push(`Next: ${result.nextCommand}`);
  return lines.join('\n');
}
