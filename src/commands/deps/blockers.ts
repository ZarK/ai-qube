import { Command, Flags, Args } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { getDirectBlockers } from '../../deps';
import { createGitHubWorkProvider } from '../../providers/github/github_work_provider';
import { githubIssueNumber } from '../../providers/github/github_work_codec';

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

export default class DepsBlockers extends Command {
  static description = commandDescription('deps blockers');

  static args = {
    issue: Args.string({ required: true, description: 'Issue number (e.g. 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable blockers list',
      default: false,
    }),
  };

  static examples = commandExamples('deps blockers');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DepsBlockers);
    const issueNumber = parseIssueNumber(args.issue);

    const workItem = await createGitHubWorkProvider().getWorkItem({ providerId: 'github', id: String(issueNumber) });
    const issue = { number: githubIssueNumber(workItem), title: workItem.title, state: workItem.state === 'open' ? 'OPEN' : 'CLOSED' };
    const blockers = await getDirectBlockers(issueNumber);

    if (flags.json) {
      this.logJson({
        ok: true,
        command: 'deps blockers',
        issue: { number: issue.number, title: issue.title, state: issue.state },
        blockers,
      });
      return;
    }

    this.log(`Direct blockers for #${issue.number} "${issue.title}" (${issue.state}):`);
    if (blockers.length === 0) {
      this.log('  None declared.');
      return;
    }

    for (const b of blockers) {
      this.log(`  #${b.number} "${b.title}" (${b.state})`);
    }
  }
}
