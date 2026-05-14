/**
 * aie doctor (placeholder in M1.2, full implementation in M1.4)
 * --help already documents mutation = false via metadata + CustomHelp.
 */

import { NotImplementedCommand } from '../base_command';
import { getCommandSpec } from '../command_metadata';

const spec = getCommandSpec('doctor')!;

export default class Doctor extends NotImplementedCommand {
  static id = spec.id;
  static summary = spec.summary;
  static description = spec.description;
  static examples = spec.examples;
  static enableJsonFlag = spec.supportsJson;
}
