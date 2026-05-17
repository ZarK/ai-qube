import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata';

export default class Branch extends Command {
  static description = commandDescription('branch');

  static examples = commandExamples('branch');

  async run(): Promise<void> {
    this.log('Use `aie branch suggest <issue>`, `aie branch check <issue>`, or `aie branch create <issue> --dry-run`.');
    this.log('`suggest` and `check` are read-only. `create` mutates git state only after worktree, dirty checkout, and base branch checks pass.');
  }
}
