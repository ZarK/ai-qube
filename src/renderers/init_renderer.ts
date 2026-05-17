import type { InitResult } from '../init';

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
  lines.push(`Policy: naming rules ${result.policy.namingRules ? 'enabled' : 'disabled'}, milestone ordering ${result.policy.milestoneOrdering ? 'enabled' : 'disabled'}, supply-chain safety ${result.policy.supplyChainSafety ? 'enabled' : 'disabled'}, OpenCode command alias ${result.policy.opencodeCommandAlias ? 'enabled' : 'disabled'}`);
  lines.push(`Config: ${result.configPath}`);
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
