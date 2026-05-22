import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples, CommandSchema, getImplementedCommands } from '../command_metadata.js';
import { configToFileShape, getDefaults } from '../config/index.js';

export default class Schema extends Command {
  static description = commandDescription('schema');

  static examples = commandExamples('schema');

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Emit the schema (default behavior when flag present)',
      default: true,
    }),
  };

  async run(): Promise<void> {
    await this.parse(Schema);

    const schema = {
      ok: true,
      command: 'schema',
      version: this.config.pjson.version,
      config: {
        version: getDefaults().version,
        path: 'aie.config.json',
        shape: ['version', 'providers', 'policy'],
        supportedProviders: {
          work: ['github'],
          review: ['github'],
          repository: ['local-git'],
          ci: ['github'],
          layout: ['local'],
        },
        defaultConfig: configToFileShape(getDefaults()),
      },
      commands: this.getImplementedCommands(),
    };

    // Always emit JSON for schema; human can use --help
    this.logJson(schema);
  }

  private getImplementedCommands(): CommandSchema[] {
    return getImplementedCommands();
  }
}
