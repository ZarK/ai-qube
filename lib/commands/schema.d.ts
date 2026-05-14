/**
 * aie schema --json
 *
 * Emits the full command registry as stable JSON for agents and Umpire.
 * Single source of truth is command_metadata.ts; this command just serializes it.
 */
import { BaseCommand } from '../base_command';
export default class Schema extends BaseCommand {
    static id: string;
    static summary: string;
    static description: string;
    static examples: string[];
    static enableJsonFlag: boolean;
    run(): Promise<void>;
}
//# sourceMappingURL=schema.d.ts.map