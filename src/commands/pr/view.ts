import { Args, Command, Flags } from '@oclif/core';
import { formatPrView, parsePrNumber, runPrViewService } from '../../app/pr_view.js';
import { commandDescription, commandExamples, isHelpToken } from '../../command_metadata.js';
import { loadConfigFile, ValidationError } from '../../config/index.js';

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function usageLines(): string[] {
  return [
    'Usage: aie pr view <pr> [--json]',
    '',
    'Show concise pull request state for agents without raw PR comment or review payloads.',
    'Examples:',
    ...PrView.examples.map(example => `  ${example}`),
  ];
}

export default class PrView extends Command {
  static description = commandDescription('pr view');

  static args = {
    pr: Args.string({ required: false, description: 'Pull request number for concise PR state, for example 12 or #12' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable concise PR state', default: false }),
  };

  static examples = commandExamples('pr view');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PrView);
    if (isHelpToken(args.pr)) {
      if (flags.json) this.logJson({ ok: true, command: 'pr view', usage: usageLines()[0], examples: PrView.examples });
      else this.log(usageLines().join('\n'));
      return;
    }

    let prNumber: number | null;
    try {
      prNumber = parsePrNumber(args.pr);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse pull request. Likely cause: ${cause}. Next action: run \`aie pr view 12 --json\` or \`aie pr view --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr view', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
    if (prNumber === null) {
      const message = 'Failed to run `aie pr view`: missing pull request number. Likely cause: no PR argument was provided. Next action: run `aie pr view 12 --json` or `aie pr view --help`.';
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr view', error: message, usage: usageLines()[0], examples: PrView.examples });
        process.exitCode = 1;
        return;
      }
      this.error(`${message}\n\n${usageLines().join('\n')}`, { exit: 1 });
    }

    const loaded = await loadConfigFile();
    if (!loaded.ok) {
      const output = { ok: false, command: 'pr view', errors: loaded.errors, nextAction: 'Fix aie.config.json, then inspect PR state again.' };
      if (flags.json) {
        this.logJson(output);
        this.exit(1);
      }
      this.error(`Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: fix aie.config.json, then inspect PR state again.`, { exit: 1 });
    }

    try {
      const result = await runPrViewService({ prNumber, repoRoot: loaded.root });
      if (flags.json) {
        this.logJson(result);
        return;
      }
      this.log(formatPrView(result));
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to inspect pull request #${prNumber}. Likely cause: ${cause}. Next action: verify GitHub CLI authentication, PR number, and repository permissions, then rerun \`aie pr view ${prNumber} --json\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr view', pr: prNumber, error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
