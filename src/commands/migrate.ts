import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';

export default class Migrate extends Command {
  static description = commandDescription('migrate');

  static examples = commandExamples('migrate');

  async run(): Promise<void> {
    this.log('Use `aie migrate map` to inspect legacy command mappings, or `aie migrate legacy --dry-run` to inspect legacy Executor state without mutation.');
    this.log('Migration planning preserves repository files, git history, branches, issue state, labels, and GitHub milestone assignments while reporting inventory and planned changes.');
  }
}
