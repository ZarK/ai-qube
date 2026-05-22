import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../../command_metadata.js';
import { getDefaults, loadConfigFile, ValidationError } from '../../config/index.js';
import { buildPrBodyService, formatPrBody, parsePrBodyIssueNumber } from '../../app/pr_body.js';

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function usageLines(): string[] {
  return [
    'Usage: aie pr body <issue> [--json]',
    '',
    'Draft a pull request body and merge-readiness summary from configured gates, UI audit state, and review-agent evidence.',
    'Examples:',
    ...PrBody.examples.map(example => `  ${example}`),
  ];
}

export default class PrBody extends Command {
  static description = commandDescription('pr body');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number the pull request closes, for example 93 or #93' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable PR body and readiness output', default: false }),
  };

  static examples = commandExamples('pr body');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PrBody);
    if (isHelpToken(args.issue)) {
      if (flags.json) this.logJson({ ok: true, command: 'pr body', usage: usageLines()[0], examples: PrBody.examples });
      else this.log(usageLines().join('\n'));
      return;
    }

    let issueNumber: number | null;
    try {
      issueNumber = parsePrBodyIssueNumber(args.issue);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse issue. Likely cause: ${cause}. Next action: run \`aie pr body 93\` or \`aie pr body --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr body', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
    if (issueNumber === null) {
      const message = 'Failed to run `aie pr body`: missing issue number. Likely cause: no issue argument was provided. Next action: run `aie pr body 93` or `aie pr body --help`.';
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr body', error: message, usage: usageLines()[0], examples: PrBody.examples });
        process.exitCode = 1;
        return;
      }
      this.error(`${message}\n\n${usageLines().join('\n')}`, { exit: 1 });
    }

    const loaded = await loadConfigFile();
    if (!loaded.ok) {
      const output = { ok: false, command: 'pr body', errors: loaded.errors, nextAction: 'Fix aie.config.json, then draft the PR body again.' };
      if (flags.json) {
        this.logJson(output);
        this.exit(1);
      }
      this.error(`Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: fix aie.config.json, then draft the PR body again.`, { exit: 1 });
    }

    try {
      const config = loaded.config ?? getDefaults();
      const result = await buildPrBodyService(config, { issueNumber, repoRoot: loaded.root });
      if (flags.json) {
        this.logJson(result);
        return;
      }
      this.log(formatPrBody(result));
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to draft PR body for issue #${issueNumber}. Likely cause: ${cause}. Next action: verify repository state and config, then rerun \`aie pr body ${issueNumber} --json\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'pr body', issue: issueNumber, error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
