import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { getAllBlockedIssues } from '../../deps';

export default class DepsBlocked extends Command {
  static description = commandDescription('deps blocked');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable blocked list',
      default: false,
    }),
  };

  static examples = commandExamples('deps blocked');

  async run(): Promise<void> {
    const { flags } = await this.parse(DepsBlocked);

    const blocked = await getAllBlockedIssues();

    if (flags.json) {
      this.logJson({ ok: true, command: 'deps blocked', blocked });
      return;
    }

    this.log('Blocked open issues:');
    if (blocked.length === 0) {
      this.log('  None.');
      return;
    }
    for (const b of blocked) {
      const blockerStr = b.blockers.map(x => `#${x.number} (${x.state})`).join(', ');
      this.log(`  #${b.number} "${b.title}" (${b.state}) blocked by: ${blockerStr}`);
    }
  }
}
