import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata';
import { buildMigrationMap, formatMigrationMap } from '../../migrate';

export default class MigrateMap extends Command {
  static description = commandDescription('migrate map');

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable legacy command mapping', default: false }),
  };

  static examples = commandExamples('migrate map');

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateMap);
    const map = buildMigrationMap();
    if (flags.json) {
      this.logJson(map);
      return;
    }
    this.log(formatMigrationMap(map));
  }
}
