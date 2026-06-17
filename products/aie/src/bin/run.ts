import { getImplementedCommands } from '../command_metadata.js';
import { runExecutorCli } from '../runtime.js';

function isKnownCommandPath(input: string[]): boolean {
  if (input.length === 0) return false;
  const commandName = input.join(' ');
  return getImplementedCommands().some(command => command.name === commandName);
}

function findLongestCommandPrefix(input: string[]): string[] {
  const commands = getImplementedCommands().map(command => command.name.split(' ')).sort((left, right) => right.length - left.length);
  return commands.find(parts => parts.every((part, index) => input[index] === part)) ?? [];
}

function collectJsonFlags(input: string[]): string[] {
  const flags: string[] = [];
  for (const part of input) {
    if ((part === '--json' || part === '-j') && !flags.includes(part)) flags.push(part);
  }
  return flags;
}

export function normalizeHelpArgs(input: string[]): string[] {
  if (input.length === 1 && input[0] === 'help') return ['--help'];
  if (input.length >= 2 && input[0] === 'help') return [...input.slice(1), '--help'];
  if (input.length >= 2 && input[input.length - 1] === 'help' && isKnownCommandPath(input.slice(0, -1))) return [...input.slice(0, -1), '--help'];
  if (input.includes('--help') || input.includes('-h')) {
    const prefix = findLongestCommandPrefix(input);
    if (prefix.length > 0) return [...prefix, '--help', ...collectJsonFlags(input)];
  }
  return input;
}

export async function run(input: string[] = process.argv.slice(2)): Promise<void> {
  await runExecutorCli(normalizeHelpArgs(input));
}
