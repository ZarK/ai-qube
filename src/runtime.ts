import { createCli, createCommand, runCli, type RuntimeCommand } from '@tjalve/qube-cli/runtime';
import { createRequire } from 'node:module';
import { EXECUTOR_COMMANDS, EXECUTOR_COMMAND_REGISTRY } from './command_registry.js';
import { RUNTIME_HANDLERS } from './runtime_handlers.js';

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

const requirePackage = createRequire(import.meta.url);
const packageJson = requirePackage('../package.json') as PackageJson;

function requestsJson(input: readonly string[]): boolean {
  return input.includes('--json') || input.includes('-j');
}

function createValueFlagNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const command of EXECUTOR_COMMANDS) {
    for (const flag of command.flags ?? []) {
      if (flag.type !== 'boolean') names.add(`--${flag.name}`);
    }
  }
  return names;
}

const USAGE_VALUE_FLAGS = createValueFlagNames();

function countRequiredArguments(input: readonly string[], commandParts: readonly string[]): number {
  let count = 0;
  for (let index = commandParts.length; index < input.length; index += 1) {
    const token = input[index];
    if (token === '--') {
      count += input.length - index - 1;
      break;
    }
    if (token.startsWith('--')) {
      const [flag] = token.split('=', 1);
      if (!token.includes('=') && USAGE_VALUE_FLAGS.has(flag)) index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    count += 1;
  }
  return count;
}

function writeUsage(input: readonly string[]): number | undefined {
  const json = requestsJson(input);
  const usages: Record<string, { usage: string; examples: string[]; human: string }> = {
    'branch suggest': {
      usage: 'aie branch suggest <issue>',
      examples: ['aie branch suggest 93', 'aie branch suggest #93 --json'],
      human: 'Usage: aie branch suggest <issue>\n\nExamples:\n  aie branch suggest 93\n  aie branch suggest #93 --json\n',
    },
    complete: {
      usage: 'aie complete <issue> [--check-only] [--dry-run] [--force] [--json]',
      examples: ['aie complete 93 --check-only', 'aie complete 93 --dry-run', 'aie complete #93 --json', 'aie complete 93 --force'],
      human: [
        'Usage: aie complete <issue> [--check-only] [--dry-run] [--force] [--json]',
        'Complete post-merge issue work, clean lifecycle labels, close open issues, and refresh dependents. This command can mutate GitHub.',
        '',
      ].join('\n'),
    },
    init: {
      usage: 'aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]',
      examples: ['aie init . --dry-run', 'aie init . --json', 'aie init . --defaults --yes', 'aie init . --tool all --naming-rules', 'aie init . --tool opencode --opencode-command-alias', 'aie init . --no-milestone-ordering --package-age-days 7'],
      human: 'Usage: aie init <target> [--tool opencode|codex|claude-code|all] [--defaults] [--yes] [--dry-run] [--force] [--json]\nInitialize Executor config and managed instruction files in a repository. This command mutates local files.\n',
    },
    switch: {
      usage: 'aie switch <issue> [--from <issue>]',
      examples: ['aie switch 94 --dry-run', 'aie switch #94 --json', 'aie switch 94 --from 93', 'aie switch 94 --no-assign --no-comment'],
      human: 'Usage: aie switch <issue> [--from <issue>]\nPause the current in-progress issue and start a target issue after queue, blocker, and repository safety checks. This command can mutate GitHub.\n',
    },
  };
  const path = Object.keys(usages).sort((left, right) => right.length - left.length).find(command => {
    const parts = command.split(' ');
    return parts.every((part, index) => input[index] === part) && countRequiredArguments(input, parts) === 0;
  });
  if (!path) return undefined;
  const usage = usages[path];
  if (!usage) return undefined;
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, command: path, usage: usage.usage, examples: usage.examples })}\n`);
  else process.stdout.write(usage.human);
  process.exitCode = 0;
  return 0;
}

function writeInitParseError(input: readonly string[]): number | undefined {
  const optionIndex = input.indexOf('--missing-milestone');
  const inline = input.find(token => token.startsWith('--missing-milestone='));
  const value = inline?.split('=', 2)[1] ?? (optionIndex === -1 ? undefined : input[optionIndex + 1]);
  if (input[0] !== 'init' || value === undefined || value === 'ignore' || value === 'warn' || value === 'block') return undefined;
  const message = `Failed to parse init arguments. Likely cause: Expected --missing-milestone=${value} to be one of: ignore, warn, block. Next action: run \`aie init --help\` and use a supported flag value.`;
  if (requestsJson(input)) process.stdout.write(`${JSON.stringify({ ok: false, command: 'init', error: message })}\n`);
  else process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
  return 1;
}

function createRuntimeCommands(): RuntimeCommand[] {
  return EXECUTOR_COMMANDS.map(command => {
    const handler = RUNTIME_HANDLERS[command.name];
    if (!handler) {
      throw new Error(`Failed to create runtime command for "${command.name}". Likely cause: no handler is registered. Next action: add a command handler for the registered command.`);
    }
    return createCommand(command, handler);
  });
}

export async function runExecutorCli(input: readonly string[]): Promise<number> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const preflightExitCode = writeInitParseError(input) ?? writeUsage(input);
  if (preflightExitCode !== undefined) return preflightExitCode;
  const result = await runCli(createCli({
    bin: 'aie',
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    description: packageJson.description,
    registry: EXECUTOR_COMMAND_REGISTRY,
    commands: createRuntimeCommands(),
  }), input);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  const exitCode = typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : result.exitCode;
  process.exitCode = exitCode === 0 ? previousExitCode : exitCode;
  return exitCode;
}
