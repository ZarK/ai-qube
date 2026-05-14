/**
 * Shared command metadata model for Executor CLI.
 *
 * This is the single source of truth for:
 * - human help text (root landing, topic/incomplete, mutation labels)
 * - aie schema --json (agent contract)
 * - completion suggestions and "did you mean"
 * - error kinds and predictable exit codes
 * - dry-run / JSON capability
 *
 * Commands extend BaseCommand and import their spec from here.
 * Adding a new command requires only:
 * 1. Add CommandSpec entry here.
 * 2. Create thin src/commands/<id>.ts (or nested for topics) that extends BaseCommand.
 *
 * No generated code, no ad-hoc string parsing, no hidden global state.
 */
export declare const EXIT_CODES: {
    readonly SUCCESS: 0;
    readonly INTERNAL_ERROR: 1;
    readonly USER_ERROR: 2;
    readonly NOT_IMPLEMENTED: 3;
};
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export interface CommandSpec {
    /** Stable command id, e.g. "doctor", "labels setup", "pr gate" */
    id: string;
    /** One-line summary for topic lists and root landing */
    summary: string;
    /** Full description shown in command help */
    description: string;
    /** Usage examples, each line starts with $ aie ... */
    examples: string[];
    /** True if command mutates local files, git state, or GitHub state */
    mutates: boolean;
    /** Whether --dry-run is supported (only for mutating commands) */
    supportsDryRun: boolean;
    /** Whether --json is supported for agent use */
    supportsJson: boolean;
    /** Stable error kinds this command can emit (for schema and tests) */
    errorKinds: string[];
    /** Default exit code on success */
    exitCode: ExitCode;
}
/** All known commands and topics. Order here affects root landing and schema output. */
export declare const COMMANDS: CommandSpec[];
/** Map for fast lookup by id */
export declare const COMMAND_BY_ID: Map<string, CommandSpec>;
/** All command ids (for suggestions, schema, completion) */
export declare const ALL_COMMAND_IDS: string[];
/**
 * Return the spec for a command id, or undefined if unknown.
 */
export declare function getCommandSpec(id: string): CommandSpec | undefined;
/**
 * Simple similarity for "did you mean" suggestions.
 * Returns up to 3 close ids when confidence is reasonable.
 * No external deps; pure stdlib.
 */
export declare function suggestSimilarCommands(unknownId: string, limit?: number): string[];
//# sourceMappingURL=command_metadata.d.ts.map