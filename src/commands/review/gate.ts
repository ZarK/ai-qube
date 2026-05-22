import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../../command_metadata.js';
import { getDefaults, loadConfigFile, ValidationError } from '../../config/index.js';
import { formatReviewGate, parseReviewIssueNumber, runReviewGate } from '../../review.js';

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function usageLines(): string[] {
  return [
    'Usage: aie review gate <issue> [--prompt] [--dry-run] [--json]',
    '',
    'Render the configured review-agent gate prompt and evidence requirements without invoking a reviewer.',
    'Examples:',
    ...ReviewGate.examples.map(example => `  ${example}`),
  ];
}

export default class ReviewGate extends Command {
  static description = commandDescription('review gate');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number for the review gate, for example 93 or #93' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable review gate guidance', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show the review gate plan without invoking reviewers or writing evidence', default: false }),
    prompt: Flags.boolean({ description: 'Print only the configured review prompt', default: false }),
  };

  static examples = commandExamples('review gate');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReviewGate);
    if (isHelpToken(args.issue)) {
      if (flags.json) this.logJson({ ok: true, command: 'review gate', usage: usageLines()[0], examples: ReviewGate.examples });
      else this.log(usageLines().join('\n'));
      return;
    }

    let issueNumber: number | null;
    try {
      issueNumber = parseReviewIssueNumber(args.issue);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse review issue. Likely cause: ${cause}. Next action: run \`aie review gate 93 --prompt\` or \`aie review gate --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'review gate', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
    if (issueNumber === null) {
      const message = 'Failed to run `aie review gate`: missing issue number. Likely cause: no issue argument was provided. Next action: run `aie review gate 93 --prompt` or `aie review gate --help`.';
      if (flags.json) {
        this.logJson({ ok: false, command: 'review gate', error: message, usage: usageLines()[0], examples: ReviewGate.examples });
        process.exitCode = 1;
        return;
      }
      this.error(`${message}\n\n${usageLines().join('\n')}`, { exit: 1 });
    }

    const loaded = await loadConfigFile();
    if (!loaded.ok) {
      const output = { ok: false, command: 'review gate', errors: loaded.errors, nextAction: 'Fix aie.config.json, then run the review gate again.' };
      if (flags.json) {
        this.logJson(output);
        this.exit(1);
      }
      this.error(`Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: fix aie.config.json, then run the review gate again.`, { exit: 1 });
    }

    const config = loaded.config ?? getDefaults();
    const result = runReviewGate(config, {
      issueNumber,
      repoRoot: loaded.root,
      dryRun: flags['dry-run'],
      promptOnly: flags.prompt,
    });
    if (flags.json) {
      this.logJson(result);
      return;
    }
    if (flags.prompt) {
      this.log(result.prompt);
      return;
    }
    this.log(formatReviewGate(result));
  }
}
