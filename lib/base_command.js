"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotImplementedCommand = exports.BaseCommand = void 0;
const core_1 = require("@oclif/core");
const command_metadata_1 = require("./command_metadata");
class BaseCommand extends core_1.Command {
    static baseFlags = {
        json: core_1.Flags.boolean({
            char: 'j',
            summary: 'Emit JSON result for agents (no decorative output)',
            default: false,
            exclusive: ['noColor'],
        }),
        'dry-run': core_1.Flags.boolean({
            summary: 'Show what would change without mutating git, GitHub, or local files',
            default: false,
            dependsOn: [], // only relevant for mutating commands; enforced at runtime
        }),
        'no-color': core_1.Flags.boolean({
            summary: 'Disable all color and terminal formatting',
            default: false,
            env: 'NO_COLOR',
        }),
    };
    spec;
    isDryRun = false;
    useJson = false;
    useColor = true;
    async init() {
        await super.init();
        // Flags are parsed by oclif using static baseFlags + per-command flags.
        // Subclasses read this.flags in their run() after this.parse() and set the
        // helpers (useJson, isDryRun, useColor). Base defaults are conservative.
        // no-color is also respected via process.env.NO_COLOR by ansis/supports-color.
        const id = this.ctor.id || this.id;
        if (id) {
            this.spec = (0, command_metadata_1.getCommandSpec)(id);
        }
    }
    /**
     * Call from subclass run() after setting this.id.
     * Ensures spec is available for help text and json.
     */
    loadSpec() {
        if (!this.spec && this.id) {
            this.spec = (0, command_metadata_1.getCommandSpec)(this.id);
        }
        return this.spec;
    }
    /**
     * Human error with required "failed operation; likely cause; next action" shape.
     * Always goes to stderr. Exits with the provided code (default USER_ERROR=2).
     */
    fail(operation, cause, nextAction, code = command_metadata_1.EXIT_CODES.USER_ERROR, kind = 'USER_ERROR') {
        const msg = `failed operation: ${operation}; likely cause: ${cause}; next action: ${nextAction}`;
        this.logToStderr(msg);
        this.exit(code);
    }
    /**
     * Success JSON emission. Data on stdout, nothing else.
     * Subclasses call this then return.
     */
    emitJson(result) {
        const payload = {
            ok: true,
            command: this.id || 'unknown',
            cwd: process.cwd(),
            result,
        };
        this.logJson(payload);
    }
    /**
     * Error JSON emission. Always non-zero exit.
     */
    emitJsonError(kind, message, cause, nextAction, code = command_metadata_1.EXIT_CODES.USER_ERROR) {
        const payload = {
            ok: false,
            command: this.id || 'unknown',
            cwd: process.cwd(),
            errors: [{ kind, message, cause, nextAction }],
        };
        this.logJson(payload);
        this.exit(code);
    }
    /**
     * Warn to stderr (progress, hints, diagnostics). Never mixes into stdout JSON.
     */
    warnToStderr(message) {
        this.logToStderr(message);
    }
    /**
     * Convenience: print a mutation warning when --dry-run is not used on a mutating command.
     */
    warnIfMutatingWithoutDryRun() {
        if (this.spec?.mutates && !this.isDryRun && !this.useJson) {
            this.warnToStderr('This command mutates state. Use --dry-run to preview changes.');
        }
    }
    /**
     * Standard "not yet implemented" handler used by all placeholder commands.
     * Exits 3 (NOT_IMPLEMENTED) so agents can distinguish from user errors.
     */
    notImplemented() {
        const spec = this.loadSpec();
        const name = this.id || 'this command';
        if (this.useJson) {
            this.emitJsonError('NOT_IMPLEMENTED', `${name} is not implemented in this version of Executor`, 'The command exists as a reserved placeholder for future milestones', `Run aie help ${name} for usage and check the milestone for when it will be available`, command_metadata_1.EXIT_CODES.NOT_IMPLEMENTED);
        }
        this.logToStderr(`${name} is not implemented yet.`);
        if (spec) {
            this.logToStderr(`Purpose: ${spec.summary}`);
            if (spec.examples.length > 0) {
                this.logToStderr('Examples:');
                for (const ex of spec.examples)
                    this.logToStderr(`  ${ex}`);
            }
        }
        this.logToStderr('This is a reserved command. It performs no mutation.');
        this.logToStderr('Next action: implement the command in the appropriate milestone or use an alternative workflow step.');
        this.exit(command_metadata_1.EXIT_CODES.NOT_IMPLEMENTED);
    }
    async catch(err) {
        // Ensure any uncaught error gets the required message shape on stderr
        const operation = this.id || 'command execution';
        const cause = err.message || 'unexpected error';
        const nextAction = 'Run aie doctor to check environment, then retry or report the issue with aie --version and full error output.';
        if (!this.useJson) {
            this.logToStderr(`failed operation: ${operation}; likely cause: ${cause}; next action: ${nextAction}`);
        }
        else {
            this.emitJsonError('INTERNAL_ERROR', operation, cause, nextAction, command_metadata_1.EXIT_CODES.INTERNAL_ERROR);
        }
        return super.catch(err);
    }
}
exports.BaseCommand = BaseCommand;
/**
 * NotImplementedCommand - base for all reserved placeholder commands in M1.2.
 * Keeps the implementation trivial and consistent.
 */
class NotImplementedCommand extends BaseCommand {
    async run() {
        this.loadSpec();
        this.notImplemented();
    }
}
exports.NotImplementedCommand = NotImplementedCommand;
//# sourceMappingURL=base_command.js.map