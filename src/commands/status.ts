import { Command, Flags } from '@oclif/core';
import { buildStatus, createStatusContext } from '../app/status_service';
import { commandDescription, commandExamples } from '../command_metadata';
import { formatStatusHuman } from '../renderers/status_renderer';

export default class Status extends Command {
  static description = commandDescription('status');

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable continuation status', default: false }),
  };

  static examples = commandExamples('status');

  async run(): Promise<void> {
    const { flags } = await this.parse(Status);
    const result = await buildStatus(await createStatusContext());
    if (flags.json) {
      this.logJson(result);
      if (!result.ok) this.exit(1);
      return;
    }
    this.log(formatStatusHuman(result));
    if (!result.ok) this.exit(1);
  }
}
