import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata.js';
import { loadConfig, getDefaults } from '../../config/index.js';
import { getDesiredLabels, computeLabelPlan, applyLabelPlan, LabelSpec } from '../../labels.js';
import { runGh } from '../../gh.js';
import { parseGhLabelList } from '../../labels.js';

export default class LabelsSetup extends Command {
  static description = commandDescription('labels setup');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable result',
      default: false,
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      description: 'Show planned changes without mutating GitHub',
      default: false,
    }),
  };

  static examples = commandExamples('labels setup');

  async run(): Promise<void> {
    const { flags } = await this.parse(LabelsSetup);
    const dryRun = flags['dry-run'];
    const json = flags.json;

    const config = (await loadConfig()) || getDefaults();
    const desired = getDesiredLabels(config);

    let listResult;
    try {
      listResult = await runGh(['label', 'list', '--json', 'name,color,description', '--limit', '1000']);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (json) {
        this.logJson({ ok: false, command: 'labels setup', dryRun, error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }

    // Shape guard for gh label list output (consistent with github.ts pattern)
    const current = parseGhLabelList(listResult.stdout);

    const plan = computeLabelPlan(current, desired);

    const hadChanges = plan.created.length > 0 || plan.updated.length > 0;

    if (json) {
      const applied = !dryRun && hadChanges;
      if (applied) {
        await applyLabelPlan(plan);
      }
      this.logJson({
        ok: true,
        command: 'labels setup',
        dryRun,
        applied,
        created: plan.created,
        updated: plan.updated,
        unchanged: plan.unchanged,
        skipped: plan.skipped,
      });
      return;
    }

    this.log(`aie labels setup${dryRun ? ' (dry-run)' : ''}`);
    this.log('');

    this.printGroup('Created', plan.created);
    this.printGroup('Updated (color or description drift)', plan.updated);
    this.printGroup('Unchanged', plan.unchanged);
    this.printGroup('Skipped (unrelated to Executor)', plan.skipped);

    if (!hadChanges) {
      this.log('All configured labels are already up to date.');
      return;
    }

    if (dryRun) {
      this.log('');
      this.log('Re-run without --dry-run to apply the changes.');
      return;
    }

    await applyLabelPlan(plan);
    this.log('');
    this.log('Changes applied successfully.');
  }

  private printGroup(title: string, items: LabelSpec[]): void {
    if (items.length === 0) return;
    this.log(`${title}:`);
    for (const item of items) {
      this.log(`  ${item.name} (color: ${item.color}, description: ${item.description})`);
    }
    this.log('');
  }
}
