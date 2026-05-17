import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { getReadyIssues } from '../../deps';

export default class DepsReady extends Command {
  static description = commandDescription('deps ready');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable ready list',
      default: false,
    }),
  };

  static examples = commandExamples('deps ready');

  async run(): Promise<void> {
    const { flags } = await this.parse(DepsReady);

    const ready = await getReadyIssues();

    if (flags.json) {
      this.logJson({ ok: true, command: 'deps ready', ready });
      return;
    }

    this.log('Ready issues (no open blockers):');
    if (ready.length === 0) {
      this.log('  None.');
      return;
    }
    for (const r of ready) {
      this.log(`  #${r.number} "${r.title}" (${r.state})`);
    }
  }
}
