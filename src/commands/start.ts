import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../command_metadata';
import { LifecycleIssueSelection, parseLifecycleIssueSelection } from '../lifecycle';
import { formatStartHuman } from '../renderers/lifecycle_renderer';
import { startIssue } from '../start';

function usageLines(): string[] {
  return [
    'Usage: aie start [next|<issue>]',
    Start.description,
    '',
    'Behavior:',
    '  aie start shows this usage; aie start next resumes the single active issue before selecting ready work.',
    '  aie start <issue> starts one specific issue only when blockers and active-issue rules allow it.',
    '  Starting new work is blocked by linked worktrees, blocking open pull requests, or stale base branch state.',
    '',
    'Examples:',
    ...Start.examples.map(example => `  ${example}`),
  ];
}

export default class Start extends Command {
  static description = commandDescription('start');

  static args = {
    issue: Args.string({ required: false, description: 'Issue selector: next, a bare number such as 93, or shell-safe #93' }),
  };

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit machine-readable start plan and result',
      default: false,
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      description: 'Show planned lifecycle changes without mutating GitHub',
      default: false,
    }),
    'no-assign': Flags.boolean({
      description: 'Do not assign the issue even when repository policy enables start assignment',
      default: false,
    }),
    'no-comment': Flags.boolean({
      description: 'Do not add a started-work comment even when repository policy enables start comments',
      default: false,
    }),
  };

  static examples = commandExamples('start');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Start);
    if (!args.issue || isHelpToken(args.issue)) {
      if (flags.json) {
        this.logJson({ ok: true, command: 'start', usage: 'aie start [next|<issue>]', examples: Start.examples });
        return;
      }
      this.log(usageLines().join('\n'));
      return;
    }

    let selection: LifecycleIssueSelection;
    try {
      selection = parseLifecycleIssueSelection(args.issue);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse start selector. Likely cause: ${cause}. Next action: run \`aie start next\`, \`aie start 93\`, or \`aie start --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'start', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }

    try {
      const result = await startIssue({
        selection,
        dryRun: flags['dry-run'],
        assign: !flags['no-assign'],
        comment: !flags['no-comment'],
      });
      if (flags.json) {
        this.logJson(result);
      } else {
        this.log(formatStartHuman(result));
      }
      if (!result.ok) process.exitCode = 1;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to run \`aie start\`. Likely cause: ${cause}. Next action: verify GitHub authentication, issue state, repository config, and rerun \`aie start ${args.issue ?? 'next'} --dry-run\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'start', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
