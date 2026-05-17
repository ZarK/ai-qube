import { Command, Flags, Args } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../command_metadata';
import { formatViewHuman } from '../renderers/view_renderer';
import { viewIssue } from '../view';

function parseIssueNumber(input: string | undefined): number | null {
  if (!input) return null;
  const match = input.trim().match(/^#?([1-9]\d*)$/);
  if (!match) {
    throw new Error(`Invalid issue number: ${input}. Use a bare number or #93.`);
  }
  return Number(match[1]);
}

function usageLines(): string[] {
  return [
    'Usage: aie view <issue>',
    View.description,
    '',
    'Examples:',
    ...View.examples.map(example => `  ${example}`),
  ];
}

function missingIssueMessage(): string {
  return 'Failed to run `aie view`. Likely cause: missing issue number argument. Next action: run `aie view <issue>` with a bare number or shell-safe form such as `aie view 93` or `aie view #93`.';
}

function invalidIssueMessage(input: string | undefined, cause: string): string {
  return `Failed to run \`aie view\`. Likely cause: invalid issue number ${input ?? '<missing>'}: ${cause}. Next action: provide a positive issue number such as \`aie view 93\` or \`aie view #93\`.`;
}

function issueLoadMessage(issueNumber: number, cause: string): string {
  return `Failed to load issue context for #${issueNumber}. Likely cause: ${cause}. Next action: verify the issue number, repository access, and GitHub authentication, then retry \`aie view ${issueNumber}\`.`;
}

export default class View extends Command {
  static description = commandDescription('view');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number (e.g. 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable issue view',
      default: false,
    }),
  };

  static examples = commandExamples('view');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(View);
    if (isHelpToken(args.issue)) {
      if (flags.json) {
        this.logJson({ ok: true, command: 'view', usage: 'aie view <issue>', examples: View.examples });
        return;
      }
      this.log(usageLines().join('\n'));
      return;
    }

    let issueNumber: number | null;
    try {
      issueNumber = parseIssueNumber(args.issue);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = invalidIssueMessage(args.issue, cause);
      if (flags.json) {
        this.logJson({ ok: false, command: 'view', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message);
    }

    if (issueNumber === null) {
      const message = missingIssueMessage();
      if (flags.json) {
        this.logJson({ ok: false, command: 'view', error: message, usage: 'aie view <issue>', examples: View.examples });
        process.exitCode = 1;
        return;
      }
      this.error(`${message}\n\n${usageLines().join('\n')}`, { exit: 1 });
    }

    try {
      const result = await viewIssue(issueNumber);
      if (flags.json) {
        this.logJson({ command: 'view', ...result });
        return;
      }
      this.log(formatViewHuman(result));
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = issueLoadMessage(issueNumber, cause);
      if (flags.json) {
        this.logJson({ ok: false, command: 'view', issue: issueNumber, error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message);
    }
  }
}
