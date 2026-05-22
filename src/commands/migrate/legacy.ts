import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata.js';
import { formatMigrationPlan, runMigration } from '../../migrate/index.js';

export default class MigrateLegacy extends Command {
  static description = commandDescription('migrate legacy');

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable legacy migration plan', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show the full legacy migration plan without writing files', default: false }),
    apply: Flags.boolean({ description: 'Apply explicitly requested migration writes, wrapper installs, or cleanup removals', default: false }),
    cleanup: Flags.boolean({ description: 'Plan or apply cleanup for known legacy helper files', default: false }),
    'install-wrappers': Flags.boolean({ description: 'Plan or install compatibility wrappers for known legacy helper files', default: false }),
    force: Flags.boolean({ description: 'Allow selected unmanaged instruction files or explicit cleanup paths after review', default: false }),
    instruction: Flags.string({ description: 'Instruction or command file path to migrate; repeat or comma-separate', multiple: true, delimiter: ',', multipleNonGreedy: true }),
    path: Flags.string({ description: 'Legacy helper file path to include in cleanup; repeat or comma-separate', multiple: true, delimiter: ',', multipleNonGreedy: true }),
  };

  static examples = commandExamples('migrate legacy');

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateLegacy);
    const plan = await runMigration({
      dryRun: flags['dry-run'],
      apply: flags.apply,
      force: flags.force,
      instructionPaths: flags.instruction,
      legacyPaths: flags.path,
      cleanup: flags.cleanup,
      installWrappers: flags['install-wrappers'],
    });
    if (flags.json) {
      this.logJson(plan);
      if (!plan.ok) this.exit(1);
      return;
    }
    this.log(formatMigrationPlan(plan));
    if (!plan.ok) this.exit(1);
  }
}
