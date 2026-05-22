import { Command } from '@oclif/core';
import { commandDescription, commandExamples } from '../command_metadata.js';

export default class Deps extends Command {
  static description = commandDescription('deps');

  static examples = commandExamples('deps');

  async run(): Promise<void> {
    this.log('Use `aie deps blockers <issue>`, `aie deps blocking <issue>`, `aie deps chain <issue>`, `aie deps ready`, `aie deps blocked`, `aie deps graph --json`, or `aie deps fix --dry-run`.');
    this.log('Read-only commands explain the dependency state from "Blocked by: #N" lines in issue bodies. `aie deps fix` plans and applies S-Ready/S-Blocked/S-Blocking label changes (S-InProgress issues are never changed).');
  }
}
