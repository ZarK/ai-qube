import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';

export default class Labels extends Command {
  static description = commandDescription('labels');

  static examples = commandExamples('labels');

  async run(): Promise<void> {
    this.log('Use `aie labels setup` to create or update the labels defined in aie.config.json (or the built-in defaults) idempotently.');
    this.log('This command and its subcommands can mutate GitHub labels when not in --dry-run mode.');
  }
}
