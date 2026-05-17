import { Command, Flags, Args } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { getDependencyChain } from '../../deps';

function parseIssueNumber(input: string): number {
  const cleaned = input.replace(/^#/, '').trim();
  const num = parseInt(cleaned, 10);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid issue number: ${input}. Use a bare number or #93.`);
  }
  return num;
}

export default class DepsChain extends Command {
  static description = commandDescription('deps chain');

  static args = {
    issue: Args.string({ required: true, description: 'Issue number (e.g. 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable chain',
      default: false,
    }),
  };

  static examples = commandExamples('deps chain');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DepsChain);
    const issueNumber = parseIssueNumber(args.issue);

    const chain = await getDependencyChain(issueNumber);

    if (flags.json) {
      this.logJson({ ok: true, command: 'deps chain', issue: issueNumber, chain });
      return;
    }

    this.log(`Dependency chain for #${issueNumber}:`);
    for (const b of chain) {
      this.log(`  #${b.number} "${b.title}" (${b.state})`);
    }
  }
}
