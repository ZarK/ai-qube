/**
 * CustomHelp - progressive discovery and agent-friendly help surfaces.
 *
 * Overrides showRootHelp (bare `aie`), showTopicHelp (incomplete groups like `aie labels`),
 * and augments command help with mutation/dry-run/JSON badges and examples.
 *
 * All text is derived from command_metadata.ts so it cannot drift from schema or suggestions.
 */
import { Command, Help, Interfaces } from '@oclif/core';
type Topic = Interfaces.Topic;
export declare class CustomHelp extends Help {
    /** Root landing page: concise, shows common next commands, not a raw parser dump. */
    protected showRootHelp(): Promise<void>;
    /** Topic / incomplete command help: show available subcommands + examples + mutation note. */
    protected showTopicHelp(topic: Topic): Promise<void>;
    /** Per-command help: add mutation badge, dry-run/JSON notes, examples from spec. */
    showCommandHelp(command: Command.Loadable): Promise<void>;
    private mutationBadge;
}
export default CustomHelp;
//# sourceMappingURL=help.d.ts.map