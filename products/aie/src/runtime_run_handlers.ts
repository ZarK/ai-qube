import type { RuntimeCommandHandler } from '@tjalve/qube-cli/runtime';
import { commandExamples, isHelpToken } from './command_metadata.js';
import { loadConfigFile, type ValidationError } from './config/index.js';
import { formatRunResult, runStart, runStatus, runStop, runWait } from './local_app_runner.js';
import { commandFailure, commandResult, numberFlag, readBooleanFlag, stringArg, stringFlag } from './runtime_result.js';

function lineOutput(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function formatConfigErrors(errors: ValidationError[]): string {
  return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function usageResult(context: Parameters<RuntimeCommandHandler>[0], command: string, usage: string, lines: string[]) {
  return commandResult(context, { ok: true, command, usage, examples: commandExamples(command) }, lineOutput(lines));
}

function configLoadFailure(context: Parameters<RuntimeCommandHandler>[0], command: string, loaded: { errors: ValidationError[] }, nextAction: string) {
  return commandFailure(context, { ok: false, command, errors: loaded.errors, nextAction }, `Failed to load trusted Executor config:\n${formatConfigErrors(loaded.errors)}\nNext action: ${nextAction}`);
}

const RUN_COMMAND_ARG_NAMES = ['command', ...Array.from({ length: 12 }, (_, index) => `commandArg${index + 1}`)];

function runName(context: Parameters<RuntimeCommandHandler>[0]): string {
  return stringFlag(context, 'name') ?? 'ui-audit';
}

function readRunCommand(context: Parameters<RuntimeCommandHandler>[0]): string[] {
  const separatorIndex = context.argv.indexOf('--');
  const tokens = separatorIndex >= 0
    ? context.argv.slice(separatorIndex + 1)
    : RUN_COMMAND_ARG_NAMES.map(name => stringArg(context, name)).filter((value): value is string => typeof value === 'string' && value.length > 0);
  return tokens.filter(token => token.length > 0);
}

export const handleRunStart: RuntimeCommandHandler = async context => {
  if (isHelpToken(stringArg(context, 'command'))) return usageResult(context, 'run start', 'aie run start --name <name> [--cwd <path>] -- <command...>', [
    'Usage: aie run start --name <name> [--cwd <path>] -- <command...>',
    '',
    'Start a long-running local app with hidden Windows-safe spawn options, persistent metadata, and deterministic logs.',
    'Examples:',
    ...commandExamples('run start').map(example => `  ${example}`),
  ]);
  const commandLine = readRunCommand(context);
  if (commandLine.length === 0) {
    const message = 'Failed to run `aie run start`: missing app command after `--`. Likely cause: no server command was provided. Next action: run `aie run start --name ui-audit -- npm run dev`.';
    return commandFailure(context, { ok: false, command: 'run start', error: message }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'run start', loaded, 'Fix aie.config.json, then start the local app runner again.');
  try {
    const result = runStart({
      repoRoot: loaded.root,
      name: runName(context),
      cwd: stringFlag(context, 'cwd'),
      command: commandLine,
      dryRun: readBooleanFlag(context, 'dry-run'),
    });
    return result.ok ? commandResult(context, result, formatRunResult(result)) : commandFailure(context, result, formatRunResult(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie run start\`. Likely cause: ${cause}. Next action: fix the --name, --cwd, or app command and rerun with --dry-run first.`;
    return commandFailure(context, { ok: false, command: 'run start', error: message }, message);
  }
};

export const handleRunWait: RuntimeCommandHandler = async context => {
  const url = stringFlag(context, 'url');
  if (!url) {
    const message = 'Failed to run `aie run wait`: missing --url. Likely cause: no readiness endpoint was provided. Next action: run `aie run wait --name ui-audit --url http://127.0.0.1:3000 --timeout 30`.';
    return commandFailure(context, { ok: false, command: 'run wait', error: message }, message);
  }
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'run wait', loaded, 'Fix aie.config.json, then wait for the local app runner again.');
  try {
    const result = await runWait({
      repoRoot: loaded.root,
      name: runName(context),
      url,
      timeoutSeconds: numberFlag(context, 'timeout'),
    });
    return result.ok ? commandResult(context, result, formatRunResult(result)) : commandFailure(context, result, formatRunResult(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie run wait\`. Likely cause: ${cause}. Next action: inspect runner status and logs with \`aie run status --name ${runName(context)}\`, then retry one bounded wait.`;
    return commandFailure(context, { ok: false, command: 'run wait', error: message }, message);
  }
};

export const handleRunStatus: RuntimeCommandHandler = async context => {
  try {
    const loaded = await loadConfigFile();
    if (!loaded.ok) return configLoadFailure(context, 'run status', loaded, 'Fix aie.config.json, then inspect the local app runner again.');
    const result = runStatus({ repoRoot: loaded.root, name: runName(context) });
    return result.ok ? commandResult(context, result, formatRunResult(result)) : commandFailure(context, result, formatRunResult(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie run status\`. Likely cause: ${cause}. Next action: use a safe --name value and retry.`;
    return commandFailure(context, { ok: false, command: 'run status', error: message }, message);
  }
};

export const handleRunStop: RuntimeCommandHandler = async context => {
  const loaded = await loadConfigFile();
  if (!loaded.ok) return configLoadFailure(context, 'run stop', loaded, 'Fix aie.config.json, then stop the local app runner again.');
  try {
    const result = runStop({ repoRoot: loaded.root, name: runName(context), dryRun: readBooleanFlag(context, 'dry-run') });
    return result.ok ? commandResult(context, result, formatRunResult(result)) : commandFailure(context, result, formatRunResult(result));
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    const message = `Failed to run \`aie run stop\`. Likely cause: ${cause}. Next action: inspect runner status and stop the process manually if metadata is stale.`;
    return commandFailure(context, { ok: false, command: 'run stop', error: message }, message);
  }
};
