/**
 * command_not_found hook - safe suggestions only, never auto-runs anything.
 *
 * On unknown command, computes closest matches from the shared metadata registry
 * and throws a CLIError with suggestions so the pretty printer shows "did you mean".
 * Suggestions never cause auto-execution of a different command.
 */
import { Hook } from '@oclif/core';
declare const hook: Hook<'command_not_found'>;
export default hook;
export declare const command_not_found: Hook<"command_not_found">;
//# sourceMappingURL=command_not_found.d.ts.map