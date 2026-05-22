import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../../command_metadata.js';
import { getDefaults, loadConfigFile, ValidationError } from '../../config/index.js';
import { formatPrGate, parsePrNumber, runPrGateService } from '../../app/pr_gate.js';

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function usageLines(): string[] {
  return [
    'Usage: aie pr gate <pr> [--dry-run] [--json]',
    '',
    'Request configured PR reviewers idempotently, wait the configured duration, and inspect review state before merge.',
    'Examples:',
    ...PrGate.examples.map(example => `  ${example}`),
  ];
}

export default class PrGate extends Command {
  static description = commandDescription('pr gate');

  static args = {
    pr: Args.string({ required: false, description: 'Pull request number for the PR review gate, for example 12 or #12' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable PR review gate output', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show reviewer request, comment, and wait plans without mutating GitHub or sleeping', default: false }),
  };

  static examples = commandExamples('pr gate');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PrGate);
    if (isHelpToken(args.pr)) {
      if (flags.json) this.logJson({ ok: true, command: 'pr gate', usage: usageLines()[0], examples: PrGate.examples });
      else this.log(usageLines().join('\n'));
      return;
    }

    let prNumber: number | null;
    try {
      prNumber = parsePrNumber(args.pr);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse pull request. Likely cause: ${cause}. Next action: run \`aie pr gate 12 --dry-run\` or \`aie pr gate --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr gate', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
    if (prNumber === null) {
      const message = 'Failed to run `aie pr gate`: missing pull request number. Likely cause: no PR argument was provided. Next action: run `aie pr gate 12 --dry-run` or `aie pr gate --help`.';
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr gate', error: message, usage: usageLines()[0], examples: PrGate.examples });
        process.exitCode = 1;
        return;
      }
      this.error(`${message}\n\n${usageLines().join('\n')}`, { exit: 1 });
    }

    const loaded = await loadConfigFile();
    if (!loaded.ok) {
      const output = { ok: false, command: 'pr gate', errors: loaded.errors, nextAction: 'Fix aie.config.json, then run the PR gate again.' };
      if (flags.json) {
        this.logJson(output);
        this.exit(1);
      }
      this.error(`Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: fix aie.config.json, then run the PR gate again.`, { exit: 1 });
    }

    try {
      const config = loaded.config ?? getDefaults();
      const result = await runPrGateService(config, {
        prNumber,
        dryRun: flags['dry-run'],
        repoRoot: loaded.root,
        onBeforeMutate: message => {
          this.warn(message);
        },
      });
      if (flags.json) {
        this.logJson(result);
        return;
      }
      this.log(formatPrGate(result));
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to run PR review gate for #${prNumber}. Likely cause: ${cause}. Next action: verify GitHub CLI authentication, PR number, and repository permissions, then rerun \`aie pr gate ${prNumber} --dry-run\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr gate', pr: prNumber, error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
