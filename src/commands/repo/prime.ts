import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { getDefaults, loadConfig } from '../../config';
import { buildRepoPrimePlan } from '../../repo';
import { formatRepoPrimeHuman } from '../../renderers/repo_renderer';

export default class RepoPrime extends Command {
  static description = commandDescription('repo prime');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable repository priming results',
      default: false,
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      description: 'Show checks and planned changes without mutating GitHub or local files',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Allow writing a minimal aie.config.json when missing',
      default: false,
    }),
  };

  static examples = commandExamples('repo prime');

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoPrime);
    const config = (await loadConfig()) || getDefaults();
    const plan = await buildRepoPrimePlan({ config, dryRun: flags['dry-run'], yes: flags.yes });

    if (flags.json) {
      this.logJson({ ...plan, command: 'repo prime', dryRun: flags['dry-run'] });
      return;
    }

    this.log(formatRepoPrimeHuman(plan, flags['dry-run']));
  }
}
