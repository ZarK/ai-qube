import { Args, Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, isHelpToken } from '../command_metadata.js';
import { formatSwitchHuman } from '../renderers/lifecycle_renderer.js';
import { switchIssue } from '../switch/index.js';

function usageLines(): string[] {
  return [
    'Usage: aie switch <issue> [--from <issue>]',
    Switch.description,
    '',
    'Behavior:',
    '  aie switch <issue> pauses the current S-InProgress issue and starts the target issue.',
    '  Without --from, exactly one S-InProgress source issue must be present.',
    '  With --from, the named source issue must be S-InProgress and no unrelated issue can remain active.',
    '  Switching to new work is blocked by target blockers, linked worktrees, blocking open pull requests, or stale base branch state.',
    '',
    'Examples:',
    ...Switch.examples.map(example => `  ${example}`),
  ];
}

function parseIssueNumber(token: string | undefined, role: 'target' | 'source'): number {
  if (!token || isHelpToken(token)) {
    throw new Error(`Missing ${role} issue number.`);
  }
  const normalized = token.startsWith('#') ? token.slice(1) : token;
  const issueNumber = Number(normalized);
  if (Number.isInteger(issueNumber) && issueNumber > 0 && String(issueNumber) === normalized) {
    return issueNumber;
  }
  throw new Error(`Invalid ${role} issue selector "${token}". Use a positive issue number such as 93 or shell-safe #93.`);
}

export default class Switch extends Command {
  static description = commandDescription('switch');

  static args = {
    issue: Args.string({ required: false, description: 'Target issue number (for example 93 or #93)' }),
  };

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable switch plan and result', default: false }),
    'dry-run': Flags.boolean({ char: 'd', description: 'Show planned lifecycle changes without mutating GitHub', default: false }),
    from: Flags.string({ char: 'f', description: 'Source S-InProgress issue to pause before starting the target' }),
    'no-assign': Flags.boolean({ description: 'Do not assign the target issue even when repository policy enables start assignment', default: false }),
    'no-comment': Flags.boolean({ description: 'Do not add a switched-work comment even when repository policy enables start comments', default: false }),
  };

  static examples = commandExamples('switch');

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Switch);
    if (!args.issue || isHelpToken(args.issue)) {
      if (flags.json) {
        this.logJson({ ok: true, command: 'switch', usage: 'aie switch <issue> [--from <issue>]', examples: Switch.examples });
        return;
      }
      this.log(usageLines().join('\n'));
      return;
    }

    let targetIssueNumber: number;
    let fromIssueNumber: number | undefined;
    try {
      targetIssueNumber = parseIssueNumber(args.issue, 'target');
      fromIssueNumber = flags.from !== undefined ? parseIssueNumber(flags.from, 'source') : undefined;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to parse switch selector. Likely cause: ${cause}. Next action: run \`aie switch 93\`, \`aie switch 93 --from 92\`, or \`aie switch --help\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'switch', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }

    try {
      const result = await switchIssue({
        targetIssueNumber,
        fromIssueNumber,
        dryRun: flags['dry-run'],
        assign: !flags['no-assign'],
        comment: !flags['no-comment'],
      });
      if (flags.json) {
        this.logJson(result);
      } else {
        this.log(formatSwitchHuman(result));
      }
      if (!result.ok) process.exitCode = 1;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      const message = `Failed to run \`aie switch\`. Likely cause: ${cause}. Next action: verify GitHub authentication, issue state, repository config, and rerun \`aie switch ${args.issue} --dry-run\`.`;
      if (flags.json) {
        this.logJson({ ok: false, command: 'switch', error: message });
        process.exitCode = 1;
        return;
      }
      this.error(message, { exit: 1 });
    }
  }
}
