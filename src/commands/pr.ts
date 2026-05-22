import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';

export default class Pr extends Command {
  static description = commandDescription('pr');

  static examples = commandExamples('pr');

  async run(): Promise<void> {
    this.log('Use `aie pr view <pr> --json` for concise PR state before reaching for raw GitHub CLI review data.');
    this.log('Use `aie pr body <issue>` to draft PR text and readiness guidance before opening a pull request.');
    this.log('Use `aie pr gate <pr> --dry-run`, `aie pr gate <pr> --json`, or `aie pr gate <pr>` before merge.');
    this.log('PR helpers coordinate body drafting, configured reviewer requests, and review-state inspection; they never merge pull requests for you.');
  }
}
