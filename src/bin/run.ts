import { execute } from '@oclif/core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getImplementedCommands } from '../command_metadata.js';

function isKnownCommandPath(input: string[]): boolean {
  if (input.length === 0) return false;
  const commandName = input.join(' ');
  return getImplementedCommands().some(command => command.name === commandName);
}

export function normalizeHelpArgs(input: string[]): string[] {
  if (input.length === 1 && input[0] === 'help') return ['--help'];
  if (input.length >= 2 && input[0] === 'help') return [...input.slice(1), '--help'];
  if (input.length >= 2 && input[input.length - 1] === 'help' && isKnownCommandPath(input.slice(0, -1))) return [...input.slice(0, -1), '--help'];
  return input;
}

export async function run(input: string[] = process.argv.slice(2)): Promise<void> {
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(runtimeDir, '../..');
  await execute({
    dir: resolve(packageRoot, 'bin'),
    loadOptions: {
      root: packageRoot,
    },
    args: normalizeHelpArgs(input),
  });
}
