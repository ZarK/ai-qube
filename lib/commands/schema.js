"use strict";
/**
 * aie schema --json
 *
 * Emits the full command registry as stable JSON for agents and Umpire.
 * Single source of truth is command_metadata.ts; this command just serializes it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const base_command_1 = require("../base_command");
const command_metadata_1 = require("../command_metadata");
class Schema extends base_command_1.BaseCommand {
    static id = 'schema';
    static summary = 'Emit machine-readable description of all commands, flags, and contracts';
    static description = 'Prints the complete command registry as JSON. Agents and tools use this instead of scraping --help. Includes mutation, dry-run, JSON support, examples, and stable error kinds for every command.';
    static examples = ['$ aie schema --json'];
    static enableJsonFlag = true;
    async run() {
        this.loadSpec();
        if (!this.jsonEnabled()) {
            // Human mode: concise summary + pointer to --json
            this.log('Executor command schema (machine contract).');
            this.log(`${command_metadata_1.COMMANDS.length} commands/topics registered.`);
            this.log('Use --json for the full agent-facing contract.');
            this.log('See docs/cli-framework-decision.md and FR-15 for usage rules.');
            return;
        }
        // Agent contract: stable shape, no extra text
        const payload = {
            version: 1,
            generatedAt: new Date().toISOString(),
            commands: command_metadata_1.COMMANDS.map((c) => ({
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
exports.default = Schema;
//# sourceMappingURL=schema.js.map