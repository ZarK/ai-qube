/**
 * aie completion
 *
 * Prints shell completion instructions. No shell profiles are modified by install.
 * Full dynamic completion (issue numbers, labels) can be added later without changing UX contract.
 */
import { BaseCommand } from '../base_command';
export default class Completion extends BaseCommand {
    static id: string;
    static summary: string;
    static description: string;
    static examples: string[];
    static enableJsonFlag: boolean;
    static flags: {
        shell: import("@oclif/core/lib/interfaces").OptionFlag<string, import("@oclif/core/lib/interfaces").CustomOptions>;
    };
    run(): Promise<void>;
    private buildInstructions;
}
//# sourceMappingURL=completion.d.ts.map