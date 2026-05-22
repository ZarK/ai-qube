import { Command, Flags } from '@oclif/core';
import { commandDescription, commandExamples } from '../../command_metadata.js';
import { getDefaults, loadConfigFile, ValidationError } from '../../config/index.js';
import { buildGateStatus, formatGateStatus, isGateStage } from '../../gates/index.js';

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

export default class GatesStatus extends Command {
  static description = commandDescription('gates status');

  static flags = {
    json: Flags.boolean({ char: 'j', description: 'Emit machine-readable gate status', default: false }),
    stage: Flags.string({ description: 'Filter gates by stage', options: ['all', 'pre-pr', 'pre-merge'] }),
  };

  static examples = commandExamples('gates status');

  async run(): Promise<void> {
    const { flags } = await this.parse(GatesStatus);
    const loaded = await loadConfigFile();
    if (!loaded.ok) {
      const output = { ok: false, command: 'gates status', errors: loaded.errors, nextAction: 'Fix aie.config.json, then run the gate status again.' };
      if (flags.json) {
        this.logJson(output);
        this.exit(1);
      }
      this.error(`Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: fix aie.config.json, then run the gate status again.`, { exit: 1 });
    }
    const config = loaded.config ?? getDefaults();
    const stage = isGateStage(flags.stage) ? flags.stage : undefined;
    const result = buildGateStatus(config, { stage, evidenceRoot: loaded.root });
    if (flags.json) {
      this.logJson(result);
      return;
    }
    this.log(formatGateStatus(result));
  }
}
