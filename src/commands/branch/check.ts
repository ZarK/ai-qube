import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { runBranchCommand } from '../../branch';
import { branchCommandError, formatBranchResult, parseBranchIssue, shouldShowBranchHelp, usage, usageJson } from '../../branch_command';

export default class BranchCheck extends Command {
  static description = commandDescription('branch check');

  static args = {
    issue: Args.string({ required: false, description: 'Issue number (for example 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable branch verification', default: false }),
  };

  static examples = commandExamples('branch check');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchCheck);
    try {
      if (shouldShowBranchHelp(args.issue)) {
        if (flags.json) this.logJson(usageJson('branch check', BranchCheck.examples));
        else this.log(usage('branch check', BranchCheck.examples));
        return;
      }
      const issueNumber = parseBranchIssue(args.issue ?? '');
      const result = await runBranchCommand({ command: 'branch check', issueNumber });
      if (flags.json) this.logJson(result);
      else this.log(formatBranchResult(result));
      if (!result.ok) process.exitCode = 1;
    } catch (err: unknown) {
      const message = branchCommandError('branch check', args.issue, err);
      if (flags.json) {
        this.logJson({ ok: false, command: 'branch check', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
