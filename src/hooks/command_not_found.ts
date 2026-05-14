/**
 * command_not_found hook - safe suggestions only, never auto-runs anything.
 *
 * On unknown command, computes closest matches from the shared metadata registry
 * and throws a CLIError with suggestions so the pretty printer shows "did you mean".
 * Suggestions never cause auto-execution of a different command.
 */

import { Hook, Errors } from '@oclif/core';
import { suggestSimilarCommands } from '../command_metadata';

const USER_ERROR = 2;

const hook: Hook<'command_not_found'> = async function (this: Hook.Context, options) {
  const { id } = options;

  const input = typeof id === 'string' ? id : '';
  const suggestions = suggestSimilarCommands(input);

  const message = `command ${input || 'unknown'} not found`;

  const suggestionLines = suggestions.length > 0
    ? suggestions.map((s: string) => `  $ aie ${s}`)
    : [];

  const err = new Errors.CLIError(message, { code: 'COMMAND_NOT_FOUND' });
  this.log(err.message);
  if (suggestionLines.length > 0) {
    this.log('Did you mean one of these?');
    for (const line of suggestionLines) this.log(line);
  }
  this.log('Suggestions are for exploration only. Executor never auto-runs a different command.');
  this.exit(USER_ERROR);

  throw err;
};

export default hook;
export const command_not_found = hook;
