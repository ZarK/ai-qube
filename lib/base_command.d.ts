/**
 * BaseCommand - shared behavior for all Executor commands.
 *
 * Enforces:
 * - Consistent error messages: "failed operation: ...; likely cause: ...; next action: ..."
 * - Predictable exit codes from command_metadata.ts
 * - stdout for data, stderr for warnings/diagnostics/progress
 * - --json, --dry-run, --no-color wiring (when declared in spec)
 * - Mutation and dry-run labeling in help
 *
 * All concrete commands (and placeholder NotImplementedCommand) extend this.
 * No hidden global state. Small focused module (< 200 lines).
 */
import { Command, Interfaces } from '@oclif/core';
import { CommandSpec, ExitCode } from './command_metadata';
export type JsonResult<T = unknown> = {
    ok: boolean;
    command: string;
    cwd: string;
    configPath?: string;
    result?: T;
    errors?: Array<{
        kind: string;
        message: string;
        cause?: string;
        nextAction?: string;
    }>;
};
export declare abstract class BaseCommand extends Command {
    static baseFlags: {
        json: Interfaces.BooleanFlag<boolean>;
        'dry-run': Interfaces.BooleanFlag<boolean>;
        'no-color': Interfaces.BooleanFlag<boolean>;
    };
    protected spec?: CommandSpec;
    protected isDryRun: boolean;
    protected useJson: boolean;
    protected useColor: boolean;
    protected init(): Promise<void>;
    /**
     * Call from subclass run() after setting this.id.
     * Ensures spec is available for help text and json.
     */
    protected loadSpec(): CommandSpec | undefined;
    /**
     * Human error with required "failed operation; likely cause; next action" shape.
     * Always goes to stderr. Exits with the provided code (default USER_ERROR=2).
     */
    protected fail(operation: string, cause: string, nextAction: string, code?: ExitCode, kind?: string): never;
    /**
     * Success JSON emission. Data on stdout, nothing else.
     * Subclasses call this then return.
     */
    protected emitJson<T>(result: T): void;
    /**
     * Error JSON emission. Always non-zero exit.
     */
    protected emitJsonError(kind: string, message: string, cause?: string, nextAction?: string, code?: ExitCode): never;
    /**
     * Warn to stderr (progress, hints, diagnostics). Never mixes into stdout JSON.
     */
    protected warnToStderr(message: string): void;
    /**
     * Convenience: print a mutation warning when --dry-run is not used on a mutating command.
     */
    protected warnIfMutatingWithoutDryRun(): void;
    /**
     * Standard "not yet implemented" handler used by all placeholder commands.
     * Exits 3 (NOT_IMPLEMENTED) so agents can distinguish from user errors.
     */
    protected notImplemented(): never;
    protected catch(err: Error & {
        exitCode?: number;
    }): Promise<any>;
}
/**
 * NotImplementedCommand - base for all reserved placeholder commands in M1.2.
 * Keeps the implementation trivial and consistent.
 */
export declare abstract class NotImplementedCommand extends BaseCommand {
    run(): Promise<void>;
}
//# sourceMappingURL=base_command.d.ts.map