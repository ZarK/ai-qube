import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';

export default class Repo extends Command {
  static description = commandDescription('repo');

  static examples = commandExamples('repo');

  async run(): Promise<void> {
    this.log('Use `aie repo prime --dry-run` to inspect repository readiness before issue execution.');
    this.log('`aie repo prime` can create or update Executor labels and can write a minimal aie.config.json only with --yes. It never creates specs, GitHub milestones, issue batches, or agent instructions.');
  }
}
