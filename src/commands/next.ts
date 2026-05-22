import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';
import { getNextIssue } from '../queue/index.js';

export default class Next extends Command {
  static description = commandDescription('next');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable next issue and reason',
      default: false,
    }),
  };

  static examples = commandExamples('next');

  async run(): Promise<void> {
    const { flags } = await this.parse(Next);
    const next = await getNextIssue();

    if (flags.json) {
      this.logJson({ ok: true, command: 'next', ...next });
      return;
    }

    if (!next.issue) {
      this.log(next.reason);
      return;
    }

    this.log(`Next: #${next.issue.number} "${next.issue.title}" (${next.issue.state})`);
    this.log(`Reason: ${next.reason}`);
    if (next.multipleInProgress) {
      this.log('WARNING: Multiple S-InProgress issues — fix before starting new work.');
    }
    if (next.driftCount > 0) {
      this.log(`Drift: ${next.driftCount} issue(s) — consider \`aie deps fix --dry-run\` then \`aie deps fix\`.`);
    }
  }
}
