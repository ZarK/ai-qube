import { NotImplementedCommand } from '../../base_command';
import { getCommandSpec } from '../../command_metadata';

const spec = getCommandSpec('labels setup')!;

export default class LabelsSetup extends NotImplementedCommand {
  static id = spec.id;
  static summary = spec.summary;
  static description = spec.description;
  static examples = spec.examples;
  static enableJsonFlag = spec.supportsJson;
}
