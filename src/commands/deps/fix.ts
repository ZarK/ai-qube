import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { getDefaults, loadConfig } from '../../config';
import { configToExecutorPolicy } from '../../config_policy';
import { computeStatusFixPlanFromWorkItems, configToWorkQueuePolicy, StatusFixPlan } from '../../deps';
import type { ActionPlan, ActionResult } from '../../core/action_plan';
import { createGitHubWorkProvider } from '../../providers/github/github_work_provider';

export interface StatusFixResult {
  issueNumber: number;
  changed: boolean;
  add: string[];
  remove: string[];
  skipped: boolean;
  failed: boolean;
  error?: string;
  reason?: string;
}

export interface StatusFixSummary {
  ok: boolean;
  failureCount: number;
  failures: StatusFixResult[];
  changedCount: number;
  skippedCount: number;
}

export function summarizeStatusFixResults(results: StatusFixResult[]): StatusFixSummary {
  const failures = results.filter(r => r.failed);
  return {
    ok: failures.length === 0,
    failureCount: failures.length,
    failures,
    changedCount: results.filter(r => r.changed).length,
    skippedCount: results.filter(r => r.skipped).length,
  };
}

export function getStatusFixExitCode(summary: StatusFixSummary): 0 | 1 {
  return summary.ok ? 0 : 1;
}

export function formatStatusFixError(issueNumber: number, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err);
  return `Failed to synchronize labels for issue #${issueNumber}: ${cause}. Check GitHub permissions, repository label names, and gh authentication, then rerun \`aie deps fix --dry-run\` before retrying.`;
}

function issueNumberFromActionResult(result: ActionResult): number | null {
  const value = result.details.issueNumber;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function stringArrayDetail(details: Record<string, unknown>, key: string): string[] {
  const value = details[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}

export function mergeStatusFixPlanActions(plans: StatusFixPlan[], actionPlan: ActionPlan): StatusFixPlan[] {
  const merged = new Map<number, StatusFixPlan>();
  for (const plan of plans) {
    merged.set(plan.issueNumber, { ...plan, add: [...plan.add], remove: [...plan.remove] });
  }
  for (const action of actionPlan.actions) {
    const issueNumber = typeof action.details.issueNumber === 'number' && Number.isInteger(action.details.issueNumber) ? action.details.issueNumber : null;
    if (issueNumber === null) continue;
    merged.set(issueNumber, {
      issueNumber,
      add: stringArrayDetail(action.details, 'addLabels'),
      remove: stringArrayDetail(action.details, 'removeLabels'),
      skipped: false,
    });
  }
  return [...merged.values()].sort((left, right) => left.issueNumber - right.issueNumber);
}

export default class DepsFix extends Command {
  static description = commandDescription('deps fix');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable fix plan and results',
      default: false,
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      description: 'Show planned label changes without applying',
      default: false,
    }),
  };

  static examples = commandExamples('deps fix');

  async run(): Promise<void> {
    const { flags } = await this.parse(DepsFix);
    const dryRun = flags['dry-run'];
    const json = flags.json;

    const config = (await loadConfig()) ?? getDefaults();
    const provider = createGitHubWorkProvider();
    const openItems = await provider.listOpenWorkItems();
    const actionPlan = provider.planStatusSync(openItems, configToExecutorPolicy(config));
    const plans: StatusFixPlan[] = mergeStatusFixPlanActions(computeStatusFixPlanFromWorkItems(openItems, configToWorkQueuePolicy(config)), actionPlan);
    const applied = dryRun ? [] : await provider.apply(actionPlan);
    const failures = new Map<number, ActionResult>();
    for (const result of applied) {
      if (result.status === 'failed') {
        const issueNumber = issueNumberFromActionResult(result);
        if (issueNumber !== null) failures.set(issueNumber, result);
      }
    }

    const results: StatusFixResult[] = [];

    for (const plan of plans) {
      const result: StatusFixResult = {
        issueNumber: plan.issueNumber,
        changed: false,
        add: plan.add,
        remove: plan.remove,
        skipped: plan.skipped,
        failed: false,
      };

      if (plan.skipped) {
        result.reason = plan.reason;
        results.push(result);
        continue;
      }

      if (plan.add.length === 0 && plan.remove.length === 0) {
        results.push(result);
        continue;
      }

      if (dryRun) {
        result.changed = true; // would change
        results.push(result);
        continue;
      }

      const failedAction = failures.get(plan.issueNumber);
      if (failedAction) {
        result.failed = true;
        result.error = formatStatusFixError(plan.issueNumber, failedAction.failure?.cause ?? 'provider apply failed');
      } else {
        result.changed = true;
      }
      results.push(result);
    }

    const summary = summarizeStatusFixResults(results);

    if (json) {
      this.logJson({
        ok: summary.ok,
        command: 'deps fix',
        dryRun,
        failureCount: summary.failureCount,
        failures: summary.failures,
        plans: results,
      });
      if (!summary.ok) this.exit(getStatusFixExitCode(summary));
      return;
    }

    this.log(`aie deps fix${dryRun ? ' (dry-run)' : ''}`);
    this.log('');

    for (const r of results) {
      if (r.skipped) {
        this.log(`#${r.issueNumber}: skipped (${r.reason || 'S-InProgress'})`);
        continue;
      }
      if (r.add.length === 0 && r.remove.length === 0 && !r.error) {
        this.log(`#${r.issueNumber}: no change`);
        continue;
      }
      let msg = `#${r.issueNumber}: `;
      if (r.failed) msg += 'FAILED';
      else if (r.changed) msg += dryRun ? 'would change' : 'changed';
      if (r.add.length > 0) msg += ` +${r.add.join(',')}`;
      if (r.remove.length > 0) msg += ` -${r.remove.join(',')}`;
      if (r.error) msg += ` — ${r.error}`;
      this.log(msg);
    }

    this.log('');
    this.log(`Summary: ${summary.ok ? 'OK' : 'FAILED'} (${summary.failureCount} failed, ${summary.changedCount} changed, ${summary.skippedCount} skipped).`);

    if (!summary.ok) {
      this.log('Label sync failed for one or more issues. Fix the reported errors and rerun `aie deps fix --dry-run` before retrying.');
      this.exit(getStatusFixExitCode(summary));
    }

    if (!dryRun) {
      this.log('Label sync complete. Re-run `aie doctor` or `aie queue` to verify.');
    }
  }
}
