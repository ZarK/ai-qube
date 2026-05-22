import { Command, Flags, Args } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata.js';
import { getIssuesBlockedBy } from '../../deps.js';

function parseIssueNumber(input: string): number {
  const cleaned = input.replace(/^#/, '').trim();
  if (!/^[1-9]\d*$/.test(cleaned)) {
    throw new Error(`Invalid issue number: ${input}. Use a bare number or #93.`);
  }
  const num = Number(cleaned);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Invalid issue number: ${input}. Use a safe positive integer.`);
  }
  return num;
}

export default class DepsBlocking extends Command {
  static description = commandDescription('deps blocking');

  static args = {
    issue: Args.string({ required: true, description: 'Issue number (e.g. 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable list of issues blocked by the target',
      default: false,
    }),
  };

  static examples = commandExamples('deps blocking');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DepsBlocking);
    const issueNumber = parseIssueNumber(args.issue);

    const blocked = await getIssuesBlockedBy(issueNumber);

    if (flags.json) {
      this.logJson({ ok: true, command: 'deps blocking', issue: issueNumber, blocked });
      return;
    }

    this.log(`Open issues blocked by #${issueNumber}:`);
    if (blocked.length === 0) {
      this.log('  None.');
      return;
    }
    for (const b of blocked) {
      this.log(`  #${b.number} "${b.title}" (${b.state})`);
    }
  }
}
