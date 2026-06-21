import type { RuntimeCommandContext, RuntimeCommandResult } from '@tjalve/qube-cli/runtime';
import { getDefaults, loadConfig } from './config/index.js';
import { runGh } from './gh.js';
import { applyLabelPlan, computeLabelPlan, getDesiredLabels, parseGhLabelList, type LabelSpec } from './labels.js';
import { commandFailure, readBooleanFlag, outputJson } from './runtime_result.js';

export async function handleLabelsSetup(context: RuntimeCommandContext): Promise<RuntimeCommandResult> {
  const dryRun = readBooleanFlag(context, 'dry-run');
  try {
    const config = (await loadConfig()) || getDefaults();
    const listResult = await runGh(['label', 'list', '--json', 'name,color,description', '--limit', '1000']);
    const plan = computeLabelPlan(parseGhLabelList(listResult.stdout), getDesiredLabels(config));
    const hadChanges = plan.created.length > 0 || plan.updated.length > 0;
    if (readBooleanFlag(context, 'json')) {
      const applied = !dryRun && hadChanges;
      if (applied) await applyLabelPlan(plan);
      return { jsonStdout: outputJson({ ok: true, command: 'labels setup', dryRun, applied, created: plan.created, updated: plan.updated, unchanged: plan.unchanged, skipped: plan.skipped }) };
    }
    if (!dryRun && hadChanges) await applyLabelPlan(plan);
    return { stdout: formatLabelsSetup(plan, dryRun, hadChanges) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return commandFailure(context, { ok: false, command: 'labels setup', dryRun, error: message }, `Failed to run \`aie labels setup\`. Likely cause: ${message}. Next action: verify GitHub authentication, label permissions, and the selected Executor config, then rerun \`aie labels setup --dry-run\`.`);
  }
}

function formatLabelsSetup(plan: ReturnType<typeof computeLabelPlan>, dryRun: boolean, hadChanges: boolean): string {
  const lines = [`aie labels setup${dryRun ? ' (dry-run)' : ''}`, ''];
  addLabelGroup(lines, 'Created', plan.created);
  addLabelGroup(lines, 'Updated (color or description drift)', plan.updated);
  addLabelGroup(lines, 'Unchanged', plan.unchanged);
  addLabelGroup(lines, 'Skipped (unrelated to Executor)', plan.skipped);
  if (!hadChanges) lines.push('All configured labels are already up to date.');
  else if (dryRun) lines.push('', 'Re-run without --dry-run to apply the changes.');
  else lines.push('', 'Changes applied successfully.');
  return `${lines.join('\n')}\n`;
}

function addLabelGroup(lines: string[], title: string, labels: LabelSpec[]): void {
  if (labels.length === 0) return;
  lines.push(`${title}:`);
  for (const item of labels) lines.push(`  ${item.name} (color: ${item.color}, description: ${item.description})`);
  lines.push('');
}
