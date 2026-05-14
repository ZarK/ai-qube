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

import { Command, Flags, Interfaces } from '@oclif/core';
import * as ansis from 'ansis';
import { CommandSpec, EXIT_CODES, ExitCode, getCommandSpec } from './command_metadata';

export type JsonResult<T = unknown> = {
  ok: boolean;
  command: string;
  cwd: string;
  configPath?: string;
  result?: T;
  errors?: Array<{ kind: string; message: string; cause?: string; nextAction?: string }>;
};

export abstract class BaseCommand extends Command {
  static baseFlags = {
    json: Flags.boolean({
      char: 'j',
      summary: 'Emit JSON result for agents (no decorative output)',
      default: false,
      exclusive: ['noColor'],
    }),
    'dry-run': Flags.boolean({
      summary: 'Show what would change without mutating git, GitHub, or local files',
      default: false,
      dependsOn: [], // only relevant for mutating commands; enforced at runtime
    }),
    'no-color': Flags.boolean({
      summary: 'Disable all color and terminal formatting',
      default: false,
      env: 'NO_COLOR',
    }),
  };

  protected spec?: CommandSpec;
  protected isDryRun = false;
  protected useJson = false;
  protected useColor = true;

  protected async init(): Promise<void> {
    await super.init();

    // Flags are parsed by oclif using static baseFlags + per-command flags.
    // Subclasses read this.flags in their run() after this.parse() and set the
    // helpers (useJson, isDryRun, useColor). Base defaults are conservative.
    // no-color is also respected via process.env.NO_COLOR by ansis/supports-color.

    const id = (this.ctor as any).id || this.id;
    if (id) {
      this.spec = getCommandSpec(id);
    }
  }

  /**
   * Call from subclass run() after setting this.id.
   * Ensures spec is available for help text and json.
   */
  protected loadSpec(): CommandSpec | undefined {
    if (!this.spec && this.id) {
      this.spec = getCommandSpec(this.id);
    }
    return this.spec;
  }

  /**
   * Human error with required "failed operation; likely cause; next action" shape.
   * Always goes to stderr. Exits with the provided code (default USER_ERROR=2).
   */
  protected fail(
    operation: string,
    cause: string,
    nextAction: string,
    code: ExitCode = EXIT_CODES.USER_ERROR,
    kind = 'USER_ERROR'
  ): never {
    const msg = `failed operation: ${operation}; likely cause: ${cause}; next action: ${nextAction}`;
    this.logToStderr(msg);
    this.exit(code);
  }

  /**
   * Success JSON emission. Data on stdout, nothing else.
   * Subclasses call this then return.
   */
  protected emitJson<T>(result: T): void {
    const payload: JsonResult<T> = {
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
  protected emitJsonError(
    kind: string,
    message: string,
    cause?: string,
    nextAction?: string,
    code: ExitCode = EXIT_CODES.USER_ERROR
  ): never {
    const payload: JsonResult = {
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
  protected warnToStderr(message: string): void {
    this.logToStderr(message);
  }

  /**
   * Convenience: print a mutation warning when --dry-run is not used on a mutating command.
   */
  protected warnIfMutatingWithoutDryRun(): void {
    if (this.spec?.mutates && !this.isDryRun && !this.useJson) {
      this.warnToStderr('This command mutates state. Use --dry-run to preview changes.');
    }
  }

  /**
   * Standard "not yet implemented" handler used by all placeholder commands.
   * Exits 3 (NOT_IMPLEMENTED) so agents can distinguish from user errors.
   */
  protected notImplemented(): never {
    const spec = this.loadSpec();
    const name = this.id || 'this command';
    if (this.useJson) {
      this.emitJsonError(
        'NOT_IMPLEMENTED',
        `${name} is not implemented in this version of Executor`,
        'The command exists as a reserved placeholder for future milestones',
        `Run aie help ${name} for usage and check the milestone for when it will be available`,
        EXIT_CODES.NOT_IMPLEMENTED
      );
    }
    this.logToStderr(`${name} is not implemented yet.`);
    if (spec) {
      this.logToStderr(`Purpose: ${spec.summary}`);
      if (spec.examples.length > 0) {
        this.logToStderr('Examples:');
        for (const ex of spec.examples) this.logToStderr(`  ${ex}`);
      }
    }
    this.logToStderr('This is a reserved command. It performs no mutation.');
    this.logToStderr('Next action: implement the command in the appropriate milestone or use an alternative workflow step.');
    this.exit(EXIT_CODES.NOT_IMPLEMENTED);
  }

  protected async catch(err: Error & { exitCode?: number }): Promise<any> {
    // Ensure any uncaught error gets the required message shape on stderr
    const operation = this.id || 'command execution';
    const cause = err.message || 'unexpected error';
    const nextAction = 'Run aie doctor to check environment, then retry or report the issue with aie --version and full error output.';
    if (!this.useJson) {
      this.logToStderr(`failed operation: ${operation}; likely cause: ${cause}; next action: ${nextAction}`);
    } else {
      this.emitJsonError('INTERNAL_ERROR', operation, cause, nextAction, EXIT_CODES.INTERNAL_ERROR);
    }
    return super.catch(err);
  }
}

/**
 * NotImplementedCommand - base for all reserved placeholder commands in M1.2.
 * Keeps the implementation trivial and consistent.
 */
export abstract class NotImplementedCommand extends BaseCommand {
  async run(): Promise<void> {
    this.loadSpec();
    this.notImplemented();
  }
}
