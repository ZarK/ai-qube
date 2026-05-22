import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../command_metadata.js';
import { completeIssue } from '../complete/index.js';
import { formatCompleteHuman } from '../renderers/lifecycle_renderer.js';

function usageLines(): string[] {
  return [
    'Usage: aie complete <issue> [--check-only] [--dry-run] [--force] [--json]',
    Complete.description,
    '',
    'Behavior:',
    '  aie complete <issue> runs after a pull request has merged, even when the PR already closed the issue.',
    '  --check-only verifies checklist and completion readiness without mutating GitHub.',
    '  --dry-run shows status cleanup, close, and dependent refresh actions without applying them.',
    '  --force permits completion with unchecked checklist items when repository policy allows it.',
    '',
    'Examples:',
    ...Complete.examples.map(example => `  ${example}`),
  ];
}

function parseIssueNumber(token: string | undefined): number {
  if (!token || isHelpToken(token)) {
    throw new Error('Missing issue number.');
  }
  const normalized = token.startsWith('#') ? token.slice(1) : token;
  const issueNumber = Number(normalized);
  if (Number.isInteger(issueNumber) && issueNumber > 0 && String(issueNumber) === normalized) {
    return issueNumber;
  }
  throw new Error(`Invalid issue selector "${token}". Use a positive issue number such as 93 or shell-safe #93.`);
}

export default class Complete extends Command {
  static description = commandDescription('complete');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number to complete (for example 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable completion plan and result', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show planned completion changes without mutating GitHub', default: false }),
    'check-only': Flags.boolean({ description: 'Verify completion readiness without mutating GitHub', default: false }),
    force: Flags.boolean({ char: 'f', description: 'Allow completion with unchecked checklist items', default: false }),
  };

  static examples = commandExamples('complete');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Complete);
    if (!args.issue || isHelpToken(args.issue)) {
      if (flags.json) {
        this.logJson({ ok: true, command: 'complete', usage: 'aie complete <issue> [--check-only] [--dry-run] [--force] [--json]', examples: Complete.examples });
        return;
      }
      this.log(usageLines().join('\n'));
      return;
    }

    let issueNumber: number;
    try {
      issueNumber = parseIssueNumber(args.issue);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse complete selector. Likely cause: ${cause}. Next action: run \`aie complete 93 --check-only\`, \`aie complete 93 --dry-run\`, or \`aie complete --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'complete', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }

    try {
      const result = await completeIssue({
        issueNumber,
        dryRun: flags['dry-run'],
        checkOnly: flags['check-only'],
        force: flags.force,
      });
      if (flags.json) this.logJson(result);
      else this.log(formatCompleteHuman(result));
      if (!result.ok) process.exitCode = 1;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to run \`aie complete\`. Likely cause: ${cause}. Next action: verify GitHub authentication, issue state, repository config, and rerun \`aie complete ${args.issue} --check-only\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'complete', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
