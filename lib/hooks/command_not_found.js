"use strict";
/**
 * command_not_found hook - safe suggestions only, never auto-runs anything.
 *
 * On unknown command, computes closest matches from the shared metadata registry
 * and throws a CLIError with suggestions so the pretty printer shows "did you mean".
 * Suggestions never cause auto-execution of a different command.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.command_not_found = void 0;
const core_1 = require("@oclif/core");
const command_metadata_1 = require("../command_metadata");
const USER_ERROR = 2;
const hook = async function (options) {
    const { id } = options;
    const input = typeof id === 'string' ? id : '';
    const suggestions = (0, command_metadata_1.suggestSimilarCommands)(input);
    const message = `command ${input || 'unknown'} not found`;
    const suggestionLines = suggestions.length > 0
        ? suggestions.map((s) => `  $ aie ${s}`)
        : [];
    const err = new core_1.Errors.CLIError(message, { code: 'COMMAND_NOT_FOUND' });
    this.log(err.message);
    if (suggestionLines.length > 0) {
        this.log('Did you mean one of these?');
        for (const line of suggestionLines)
            this.log(line);
    }
    this.log('Suggestions are for exploration only. Executor never auto-runs a different command.');
    this.exit(USER_ERROR);
    throw err;
};
exports.default = hook;
exports.command_not_found = hook;
//# sourceMappingURL=command_not_found.js.map