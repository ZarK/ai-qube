import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata.js';
import { runBranchCommand } from '../../branch.js';
import { branchCommandError, formatBranchResult, parseBranchIssue, shouldShowBranchHelp, usage, usageJson } from '../../branch_command.js';

export default class BranchCreate extends Command {
  static description = commandDescription('branch create');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number (for example 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable branch creation result', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show planned git action without mutating git state', default: false }),
  };

  static examples = commandExamples('branch create');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchCreate);
    try {
      if (shouldShowBranchHelp(args.issue)) {
        if (flags.json) this.logJson(usageJson('branch create', BranchCreate.examples));
        else this.log(usage('branch create', BranchCreate.examples));
        return;
      }
      const issueNumber = parseBranchIssue(args.issue ?? '');
      const result = await runBranchCommand({ command: 'branch create', issueNumber, dryRun: flags['dry-run'] });
      if (flags.json) this.logJson(result);
      else this.log(formatBranchResult(result));
      if (!result.ok) process.exitCode = 1;
    } catch (err: unknown) {
      const message = branchCommandError('branch create', args.issue, err);
      if (flags.json) {
        this.logJson({ ok: false, command: 'branch create', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
