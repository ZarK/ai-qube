import type { RuntimeCommandContext, RuntimeCommandResult } from '@tjalve/qube-cli/runtime';
import type { ActionPlan, ActionResult } from './core/action_plan.js';
import { getDefaults, loadConfig } from './config/index.js';
import { configToExecutorPolicy } from './config_policy.js';
import { computeStatusFixPlanFromWorkItems, configToWorkQueuePolicy, type StatusFixPlan } from './deps.js';
import { createGitHubWorkProvider } from './providers/github/github_work_provider.js';
import { commandFailure, readBooleanFlag, outputJson } from './runtime_result.js';

interface StatusFixResult {
  issueNumber: number;
  changed: boolean;
  add: string[];
  remove: string[];
  skipped: boolean;
  failed: boolean;
  error?: string;
  reason?: string;
}

function issueNumberFromActionResult(result: ActionResult): number | null {
  const value = result.details.issueNumber;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function stringArrayDetail(details: Record<string, unknown>, key: string): string[] {
  const value = details[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}

function mergeStatusFixPlanActions(plans: StatusFixPlan[], actionPlan: ActionPlan): StatusFixPlan[] {
  const merged = new Map<number, StatusFixPlan>();
  for (const plan of plans) merged.set(plan.issueNumber, { ...plan, add: [...plan.add], remove: [...plan.remove] });
  for (const action of actionPlan.actions) {
    const issueNumber = typeof action.details.issueNumber === 'number' && Number.isInteger(action.details.issueNumber) ? action.details.issueNumber : null;
    if (issueNumber === null) continue;
    merged.set(issueNumber, { issueNumber, add: stringArrayDetail(action.details, 'addLabels'), remove: stringArrayDetail(action.details, 'removeLabels'), skipped: false });
  }
  return [...merged.values()].sort((left, right) => left.issueNumber - right.issueNumber);
}

export async function handleDepsFix(context: RuntimeCommandContext): Promise<RuntimeCommandResult> {
  const dryRun = readBooleanFlag(context, 'dry-run');
  try {
    const config = (await loadConfig()) ?? getDefaults();
    const provider = createGitHubWorkProvider();
    const openItems = await provider.listOpenWorkItems();
    const actionPlan = provider.planStatusSync(openItems, configToExecutorPolicy(config));
    const plans = mergeStatusFixPlanActions(computeStatusFixPlanFromWorkItems(openItems, configToWorkQueuePolicy(config)), actionPlan);
    const applied = dryRun ? [] : await provider.apply(actionPlan);
    const failures = new Map<number, ActionResult>();
    for (const result of applied) {
      if (result.status === 'failed') {
        const issueNumber = issueNumberFromActionResult(result);
        if (issueNumber !== null) failures.set(issueNumber, result);
      }
    }
    const results = plans.map(plan => statusFixResult(plan, failures, dryRun));
    const failureCount = results.filter(result => result.failed).length;
    const summary = { ok: failureCount === 0, failureCount, failures: results.filter(result => result.failed), changedCount: results.filter(result => result.changed).length, skippedCount: results.filter(result => result.skipped).length };
    if (readBooleanFlag(context, 'json')) {
      if (!summary.ok) process.exitCode = 1;
      return { jsonStdout: outputJson({ ok: summary.ok, command: 'deps fix', dryRun, failureCount: summary.failureCount, failures: summary.failures, plans: results }) };
    }
    return { stdout: formatDepsFix(results, summary, dryRun), exitCode: summary.ok ? 0 : 1 };
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie deps fix\`. Likely cause: ${cause}. Next action: verify GitHub authentication, repository config, and label permissions, then rerun \`aie deps fix --dry-run\`.`;
    return commandFailure(context, { ok: false, command: 'deps fix', dryRun, error: message }, message);
  }
}

function statusFixResult(plan: StatusFixPlan, failures: Map<number, ActionResult>, dryRun: boolean): StatusFixResult {
  const result: StatusFixResult = { issueNumber: plan.issueNumber, changed: false, add: plan.add, remove: plan.remove, skipped: plan.skipped, failed: false };
  if (plan.skipped) return { ...result, reason: plan.reason };
  if (plan.add.length === 0 && plan.remove.length === 0) return result;
  if (dryRun) return { ...result, changed: true };
  const failedAction = failures.get(plan.issueNumber);
  if (!failedAction) return { ...result, changed: true };
  const cause = failedAction.failure?.cause ?? 'provider apply failed';
  return { ...result, failed: true, error: `Failed to synchronize labels for issue #${plan.issueNumber}: ${cause}. Check GitHub permissions, repository label names, and gh authentication, then rerun \`aie deps fix --dry-run\` before retrying.` };
}

function formatDepsFix(results: StatusFixResult[], summary: { ok: boolean; failureCount: number; changedCount: number; skippedCount: number }, dryRun: boolean): string {
  const lines = [`aie deps fix${dryRun ? ' (dry-run)' : ''}`, ''];
  for (const result of results) {
    if (result.skipped) {
      lines.push(`#${result.issueNumber}: skipped (${result.reason || 'S-InProgress'})`);
      continue;
    }
    if (result.add.length === 0 && result.remove.length === 0 && !result.error) {
      lines.push(`#${result.issueNumber}: no change`);
      continue;
    }
    let line = `#${result.issueNumber}: `;
    if (result.failed) line += 'FAILED';
    else if (result.changed) line += dryRun ? 'would change' : 'changed';
    if (result.add.length > 0) line += ` +${result.add.join(',')}`;
    if (result.remove.length > 0) line += ` -${result.remove.join(',')}`;
    if (result.error) line += ` - ${result.error}`;
    lines.push(line);
  }
  lines.push('', `Summary: ${summary.ok ? 'OK' : 'FAILED'} (${summary.failureCount} failed, ${summary.changedCount} changed, ${summary.skippedCount} skipped).`);
  if (!summary.ok) lines.push('Label sync failed for one or more issues. Fix the reported errors and rerun `aie deps fix --dry-run` before retrying.');
  if (summary.ok && !dryRun) lines.push('Label sync complete. Re-run `aie doctor` or `aie queue` to verify.');
  return `${lines.join('\n')}\n`;
}
