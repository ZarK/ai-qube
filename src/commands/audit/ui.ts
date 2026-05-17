import { Args, Command, Flags } from '@oclif/core';
import { getDefaults, loadConfigFile, ValidationError } from '../../config';
import { commandDescription, commandExamples, isHelpToken } from '../../command_metadata';
import { formatUiAudit, parseAuditIssueNumber, runUiAudit } from '../../audit';

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function usageLines(): string[] {
  return [
    'Usage: aie audit ui <issue> [--prepare] [--check] [--dry-run] [--json]',
    '',
    'Plan and inspect a manual UI audit for a real running application.',
    'Examples:',
    ...AuditUi.examples.map(example => `  ${example}`),
  ];
}

export default class AuditUi extends Command {
  static description = commandDescription('audit ui');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number for local audit evidence, for example 93 or #93' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable audit guidance', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show the audit plan without writing local evidence directories', default: false }),
    prepare: Flags.boolean({ description: 'Create the local evidence directory and screenshots directory if missing', default: false }),
    check: Flags.boolean({ description: 'Check whether local audit evidence files or notes exist without claiming pass/fail', default: false }),
  };

  static examples = commandExamples('audit ui');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AuditUi);
    if (isHelpToken(args.issue)) {
      if (flags.json) this.logJson({ ok: true, command: 'audit ui', usage: usageLines()[0], examples: AuditUi.examples });
      else this.log(usageLines().join('\n'));
      return;
    }
    let issueNumber: number | null;
    try {
      issueNumber = parseAuditIssueNumber(args.issue);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse audit issue. Likely cause: ${cause}. Next action: run \`aie audit ui 93 --dry-run\` or \`aie audit ui --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'audit ui', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
    if (issueNumber === null) {
      const message = 'Failed to run `aie audit ui`: missing issue number. Likely cause: no issue argument was provided. Next action: run `aie audit ui 93 --dry-run` or `aie audit ui --help`.';
      if (flags.json) {
        this.logJson({ ok: false, command: 'audit ui', error: message, usage: usageLines()[0], examples: AuditUi.examples });
        process.exitCode = 1;
        return;
      }
      this.error(`${message}\n\n${usageLines().join('\n')}`, { exit: 1 });
    }

    const loaded = await loadConfigFile();
    if (!loaded.ok) {
      const output = { ok: false, command: 'audit ui', errors: loaded.errors, nextAction: 'Fix aie.config.json, then run the UI audit helper again.' };
      if (flags.json) {
        this.logJson(output);
        this.exit(1);
      }
      this.error(`Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: fix aie.config.json, then run the UI audit helper again.`, { exit: 1 });
    }

    const config = loaded.config ?? getDefaults();
    const result = runUiAudit(config, {
      issueNumber,
      repoRoot: loaded.root,
      dryRun: flags['dry-run'],
      prepare: flags.prepare,
      check: flags.check,
    });
    if (flags.json) {
      this.logJson(result);
      return;
    }
    this.log(formatUiAudit(result));
  }
}
