/**
 * aie schema --json
 *
 * Emits the full command registry as stable JSON for agents and Umpire.
 * Single source of truth is command_metadata.ts; this command just serializes it.
 */

import { BaseCommand } from '../base_command';
import { COMMANDS, CommandSpec } from '../command_metadata';

export default class Schema extends BaseCommand {
  static id = 'schema';
  static summary = 'Emit machine-readable description of all commands, flags, and contracts';
  static description = 'Prints the complete command registry as JSON. Agents and tools use this instead of scraping --help. Includes mutation, dry-run, JSON support, examples, and stable error kinds for every command.';
  static examples = ['$ aie schema --json'];
  static enableJsonFlag = true;

  async run(): Promise<void> {
    this.loadSpec();

    if (!this.jsonEnabled()) {
      // Human mode: concise summary + pointer to --json
      this.log('Executor command schema (machine contract).');
      this.log(`${COMMANDS.length} commands/topics registered.`);
      this.log('Use --json for the full agent-facing contract.');
      this.log('See docs/cli-framework-decision.md and FR-15 for usage rules.');
      return;
    }

    // Agent contract: stable shape, no extra text
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      commands: COMMANDS.map((c: CommandSpec) => ({
        id: c.id,
        summary: c.summary,
        description: c.description,
        examples: c.examples,
        mutates: c.mutates,
        supportsDryRun: c.supportsDryRun,
        supportsJson: c.supportsJson,
        errorKinds: c.errorKinds,
        exitCode: c.exitCode,
      })),
    };

    this.emitJson(payload);
  }
}
