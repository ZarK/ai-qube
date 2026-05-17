import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata';

export default class Review extends Command {
  static description = commandDescription('review');

  static examples = commandExamples('review');

  async run(): Promise<void> {
    this.log('Use `aie review gate <issue> --prompt`, `aie review gate <issue> --dry-run`, or `aie review gate <issue> --json`.');
    this.log('Review helpers render prompts and evidence requirements; Executor never invokes host-only reviewers or treats review output as policy.');
  }
}
