import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata';

export default class Audit extends Command {
  static description = commandDescription('audit');

  static examples = commandExamples('audit');

  async run(): Promise<void> {
    this.log('Use `aie audit ui <issue> --dry-run`, `aie audit ui <issue> --prepare`, or `aie audit ui <issue> --check --json`.');
    this.log('Audit helpers render manual guidance and local evidence paths; they never upload screenshots or claim pass/fail from instructions alone.');
  }
}
