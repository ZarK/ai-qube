import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata';

export default class Gates extends Command {
  static description = commandDescription('gates');

  static examples = commandExamples('gates');

  async run(): Promise<void> {
    this.log('Use `aie gates plan --dry-run`, `aie gates plan --stage pre-pr --json`, or `aie gates status --json`.');
    this.log('Gate commands are read from trusted repository config and are never executed by Executor.');
  }
}
