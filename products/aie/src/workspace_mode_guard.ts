import { readWorkspaceMode, renderLocalDevelopmentPrompt } from '@tjalve/qube-core';
import { EXECUTOR_COMMANDS } from './command_registry.js';

export interface WorkspaceModeGuardFailure {
  readonly exitCode: 5;
  readonly stdout: string;
  readonly stderr: string;
}

const TOPIC_COMMANDS = new Set(['labels', 'checklist', 'gates', 'audit', 'review', 'pr', 'branch', 'repo', 'deps', 'run']);
const ALWAYS_LOCAL_COMMANDS = new Set(['schema', 'run start', 'run wait', 'run status', 'run stop']);
const LOCAL_COMMANDS = new Set(['gates plan']);

function isHelpRequest(input: readonly string[]): boolean {
  if (input.includes('--help') || input.includes('-h') || input[0] === 'help') return true;
  if (input.at(-1) !== 'help') return false;
  const command = input.slice(0, -1).join(' ');
  return EXECUTOR_COMMANDS.some(candidate => candidate.name === command);
}

function requestedCommand(input: readonly string[]): string | null {
  if (input.length === 0 || (input.length === 1 && (input[0] === '--version' || input[0] === '-v')) || isHelpRequest(input)) return null;
  const command = [...EXECUTOR_COMMANDS]
    .sort((left, right) => right.name.split(' ').length - left.name.split(' ').length)
    .find(candidate => candidate.name.split(' ').every((part, index) => input[index] === part))
    ?.name;
  if (!command || ALWAYS_LOCAL_COMMANDS.has(command) || TOPIC_COMMANDS.has(command)) return null;
  return command;
}

function jsonRequested(input: readonly string[]): boolean {
  return input.includes('--json') || input.includes('-j');
}

function writeFailure(input: readonly string[], value: Record<string, unknown>, message: string): WorkspaceModeGuardFailure {
  if (jsonRequested(input)) {
    return { exitCode: 5, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
  }
  return { exitCode: 5, stdout: '', stderr: `Error: ${message}\n` };
}

export function guardExecutorShippingCommand(input: readonly string[], cwd = process.cwd()): WorkspaceModeGuardFailure | null {
  const command = requestedCommand(input);
  if (!command) return null;

  let state: ReturnType<typeof readWorkspaceMode>;
  try {
    state = readWorkspaceMode(cwd);
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = `Cannot run \`aie ${command}\` because the workspace mode could not be read. Likely cause: ${cause} Next action: correct the workspace \`.qube/mode.json\` file, then run \`qube mode --json\` before continuing.`;
    return writeFailure(input, {
      ok: false,
      command,
      error: message,
      errorKind: 'workspace-mode-invalid',
      nextAction: 'Correct .qube/mode.json, then run `qube mode --json` before continuing.',
    }, message);
  }

  if (state.mode === 'shipping') return null;
  if (LOCAL_COMMANDS.has(command)) return null;

  const nextAction = `Work directly on the user's request in ${state.workspaceRoot}, or run \`qube mode shipping\` there to return to the issue shipping workflow.`;
  const message = [
    `Cannot run \`aie ${command}\` while workspace mode is local at ${state.workspaceRoot}.`,
    renderLocalDevelopmentPrompt().trim(),
    `To return to the issue shipping workflow, run \`qube mode shipping\` from ${state.workspaceRoot}. Changing mode does not start or publish work.`,
  ].join('\n\n');
  return writeFailure(input, {
    ok: false,
    command,
    error: `Cannot run \`aie ${command}\` while workspace mode is local.`,
    errorKind: 'workspace-mode-local',
    mode: state.mode,
    workspaceRoot: state.workspaceRoot,
    configPath: state.configPath,
    nextAction,
  }, message);
}
