import type { RuntimeCommandContext, RuntimeCommandResult } from '@tjalve/qube-cli/runtime';
import { getDefaults, loadConfig } from './config/index.js';
import { evaluateGitHubReadiness, runGh, type GitHubReadiness } from './providers/github_adapter_exports.js';
import { applyLabelPlan, computeLabelPlan, getDesiredLabels, parseGhLabelList, type LabelSpec } from './labels.js';
import { commandFailure, readBooleanFlag, outputJson } from './runtime_result.js';

interface LabelsSetupDependencies {
  runGh: typeof runGh;
  applyLabelPlan: typeof applyLabelPlan;
  loadConfig: typeof loadConfig;
  evaluateGitHubReadiness: typeof evaluateGitHubReadiness;
}

const DEFAULT_DEPENDENCIES: LabelsSetupDependencies = { runGh, applyLabelPlan, loadConfig, evaluateGitHubReadiness };

export async function handleLabelsSetup(
  context: RuntimeCommandContext,
  dependencies: Partial<LabelsSetupDependencies> = {},
): Promise<RuntimeCommandResult> {
  const runtime = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const dryRun = readBooleanFlag(context, 'dry-run');
  try {
    const config = (await runtime.loadConfig()) || getDefaults();
    const githubReadiness = await runtime.evaluateGitHubReadiness({
      cwd: process.cwd(),
      roles: ['labels'],
      env: process.env,
    });
    if (githubReadiness.status === 'needs-action') return readinessFailure(context, dryRun, githubReadiness);
    const listResult = await runtime.runGh(['label', 'list', '--json', 'name,color,description', '--limit', '1000']);
    const plan = computeLabelPlan(parseGhLabelList(listResult.stdout), getDesiredLabels(config));
    const hadChanges = plan.created.length > 0 || plan.updated.length > 0;
    if (readBooleanFlag(context, 'json')) {
      const applied = !dryRun && hadChanges;
      if (applied) await runtime.applyLabelPlan(plan);
      return { jsonStdout: outputJson({ ok: true, command: 'labels setup', dryRun, applied, githubReadiness, created: plan.created, updated: plan.updated, unchanged: plan.unchanged, skipped: plan.skipped }) };
    }
    if (!dryRun && hadChanges) await runtime.applyLabelPlan(plan);
    return { stdout: formatLabelsSetup(plan, dryRun, hadChanges, githubReadiness) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const nextAction = 'Verify GitHub authentication and label permissions, then rerun `aie labels setup --dry-run --json`.';
    return commandFailure(
      context,
      { ok: false, command: 'labels setup', dryRun, error: message, nextAction },
      `Failed to run \`aie labels setup\`. Likely cause: ${message}. Next action: ${nextAction}`,
    );
  }
}

function readinessFailure(context: RuntimeCommandContext, dryRun: boolean, readiness: GitHubReadiness): RuntimeCommandResult {
  const nextAction = readiness.nextAction ?? 'Repair GitHub readiness, then rerun `aie labels setup --dry-run --json`.';
  return commandFailure(
    context,
    { ok: false, command: 'labels setup', dryRun, error: readiness.summary, reasonCode: readiness.reasonCode, githubReadiness: readiness, nextAction },
    `GitHub label setup is blocked (${readiness.reasonCode}): ${readiness.summary} Next action: ${nextAction}`,
  );
}

function formatLabelsSetup(plan: ReturnType<typeof computeLabelPlan>, dryRun: boolean, hadChanges: boolean, readiness: GitHubReadiness): string {
  const target = readiness.host && readiness.repository ? `${readiness.host}/${readiness.repository}` : 'unresolved';
  const lines = [
    `aie labels setup${dryRun ? ' (dry-run)' : ''}`,
    `GitHub readiness: ${readiness.status} (${readiness.reasonCode}); target=${target}; credential=${readiness.credentialSource.kind}`,
    '',
  ];
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
