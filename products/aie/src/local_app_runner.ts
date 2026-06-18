import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type RunCommand = 'run start' | 'run wait' | 'run status' | 'run stop';
export type RunStatusState = 'missing' | 'running' | 'stopped' | 'unknown';

export interface RunMetadata {
  version: 1;
  name: string;
  pid: number;
  command: string[];
  cwd: string;
  startedAt: string;
  platform: NodeJS.Platform;
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
}

export interface RunPaths {
  directory: string;
  metadataPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  detached: boolean;
  windowsHide: boolean;
  stdoutPath: string;
  stderrPath: string;
}

export interface RunStartResult {
  ok: boolean;
  command: 'run start';
  dryRun: boolean;
  name: string;
  commandLine: string[];
  cwd: string;
  pid: number | null;
  paths: RunPaths;
  spawnPlan: SpawnPlan;
  status: RunStatusState;
  nextAction: string;
  error?: string;
}

export interface RunStatusResult {
  ok: boolean;
  command: 'run status';
  name: string;
  status: RunStatusState;
  metadata: RunMetadata | null;
  paths: RunPaths;
  logTail: { stdout: string[]; stderr: string[] };
  nextAction: string;
  error?: string;
}

export interface RunWaitResult {
  ok: boolean;
  command: 'run wait';
  name: string;
  url: string;
  timeoutSeconds: number;
  elapsedMs: number;
  attempts: number;
  status: 'ready' | 'timeout' | 'missing-run' | 'stopped' | 'request-failed';
  httpStatus: number | null;
  paths: RunPaths;
  logTail: { stdout: string[]; stderr: string[] };
  nextAction: string;
  error?: string;
}

export interface RunStopResult {
  ok: boolean;
  command: 'run stop';
  dryRun: boolean;
  name: string;
  status: RunStatusState;
  pid: number | null;
  paths: RunPaths;
  logTail: { stdout: string[]; stderr: string[] };
  nextAction: string;
  error?: string;
}

export interface RunStartOptions {
  repoRoot: string;
  name: string;
  cwd?: string;
  command: string[];
  dryRun?: boolean;
  now?: Date;
  platform?: NodeJS.Platform;
}

export interface RunNameOptions {
  repoRoot: string;
  name: string;
}

export interface RunWaitOptions extends RunNameOptions {
  url: string;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RunStopOptions extends RunNameOptions {
  dryRun?: boolean;
  platform?: NodeJS.Platform;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 500;
const LOG_TAIL_LINES = 30;
const SAFE_RUN_NAME = /^[A-Za-z0-9._-]+$/;

function validateName(name: string): string {
  const normalized = name.trim();
  if (!SAFE_RUN_NAME.test(normalized)) throw new Error(`run name must contain only letters, numbers, dot, underscore, or dash; received "${name}"`);
  return normalized;
}

export function runPaths(repoRoot: string, name: string): RunPaths {
  const safeName = validateName(name);
  const directory = join(repoRoot, '.aie', 'runs', safeName);
  return {
    directory,
    metadataPath: join(directory, 'metadata.json'),
    stdoutPath: join(directory, 'stdout.log'),
    stderrPath: join(directory, 'stderr.log'),
  };
}

function resolveWorkingDirectory(repoRoot: string, cwd: string | undefined): string {
  const input = cwd?.trim() || '.';
  return resolve(repoRoot, input);
}

export function buildSpawnPlan(options: RunStartOptions, paths = runPaths(options.repoRoot, options.name)): SpawnPlan {
  if (options.command.length === 0) throw new Error('missing app command after `--`; example: aie run start --name ui-audit -- npm run dev');
  return {
    command: options.command[0],
    args: options.command.slice(1),
    cwd: resolveWorkingDirectory(options.repoRoot, options.cwd),
    detached: true,
    windowsHide: true,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  };
}

function metadataFromPlan(options: RunStartOptions, paths: RunPaths, plan: SpawnPlan, pid: number, platform: NodeJS.Platform): RunMetadata {
  return {
    version: 1,
    name: validateName(options.name),
    pid,
    command: [plan.command, ...plan.args],
    cwd: plan.cwd,
    startedAt: (options.now ?? new Date()).toISOString(),
    platform,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    metadataPath: paths.metadataPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readRunMetadata(repoRoot: string, name: string): RunMetadata | null {
  const paths = runPaths(repoRoot, name);
  if (!existsSync(paths.metadataPath)) return null;
  const parsed: unknown = JSON.parse(readFileSync(paths.metadataPath, 'utf8'));
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.pid !== 'number' || typeof parsed.name !== 'string') {
    throw new Error(`run metadata is malformed at ${paths.metadataPath}`);
  }
  return parsed as unknown as RunMetadata;
}

function processState(pid: number): RunStatusState {
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (err: unknown) {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : '';
    return code === 'ESRCH' ? 'stopped' : 'unknown';
  }
}

function statusFromMetadata(metadata: RunMetadata | null): RunStatusState {
  return metadata ? processState(metadata.pid) : 'missing';
}

function tail(path: string, maxLines = LOG_TAIL_LINES): string[] {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.length > 0).slice(-maxLines);
  } catch {
    return [];
  }
}

function logTail(paths: RunPaths): { stdout: string[]; stderr: string[] } {
  return { stdout: tail(paths.stdoutPath), stderr: tail(paths.stderrPath) };
}

function safeClose(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The descriptor may already have been handed off and closed after spawn.
  }
}

export function runStatus(options: RunNameOptions): RunStatusResult {
  const paths = runPaths(options.repoRoot, options.name);
  try {
    const metadata = readRunMetadata(options.repoRoot, options.name);
    const status = statusFromMetadata(metadata);
    return {
      ok: true,
      command: 'run status',
      name: validateName(options.name),
      status,
      metadata,
      paths,
      logTail: logTail(paths),
      nextAction: status === 'running' ? `Use \`aie run wait --name ${options.name} --url <url>\` or \`aie run stop --name ${options.name}\`.` : `Start the app with \`aie run start --name ${options.name} -- <command>\`.`,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      command: 'run status',
      name: options.name,
      status: 'unknown',
      metadata: null,
      paths,
      logTail: logTail(paths),
      nextAction: 'Inspect or remove the malformed runner metadata, then retry the status command.',
      error,
    };
  }
}

export function runStart(options: RunStartOptions): RunStartResult {
  const paths = runPaths(options.repoRoot, options.name);
  const plan = buildSpawnPlan(options, paths);
  const existing = readRunMetadata(options.repoRoot, options.name);
  const existingStatus = statusFromMetadata(existing);
  if (existingStatus === 'running') {
    return {
      ok: false,
      command: 'run start',
      dryRun: options.dryRun === true,
      name: validateName(options.name),
      commandLine: [plan.command, ...plan.args],
      cwd: plan.cwd,
      pid: existing?.pid ?? null,
      paths,
      spawnPlan: plan,
      status: 'running',
      nextAction: `Stop the existing process with \`aie run stop --name ${options.name}\`, or choose a different --name.`,
      error: `Run "${options.name}" is already running with PID ${existing?.pid}.`,
    };
  }
  if (options.dryRun) {
    return {
      ok: true,
      command: 'run start',
      dryRun: true,
      name: validateName(options.name),
      commandLine: [plan.command, ...plan.args],
      cwd: plan.cwd,
      pid: null,
      paths,
      spawnPlan: plan,
      status: 'missing',
      nextAction: `Rerun without --dry-run to start the app and write metadata under ${paths.directory}.`,
    };
  }

  mkdirSync(paths.directory, { recursive: true });
  const stdout = openSync(paths.stdoutPath, 'a');
  const stderr = openSync(paths.stderrPath, 'a');
  try {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: plan.detached,
      windowsHide: plan.windowsHide,
      stdio: ['ignore', stdout, stderr],
    });
    safeClose(stdout);
    safeClose(stderr);
    child.once('error', err => {
      appendFileSync(paths.stderrPath, `\n[aie-runner] spawn error: ${err.message}\n`);
      rmSync(paths.metadataPath, { force: true });
    });
    if (!child.pid) {
      return {
        ok: false,
        command: 'run start',
        dryRun: false,
        name: validateName(options.name),
        commandLine: [plan.command, ...plan.args],
        cwd: plan.cwd,
        pid: null,
        paths,
        spawnPlan: plan,
        status: 'missing',
        nextAction: 'Fix the app command or working directory, inspect captured logs if present, then retry once.',
        error: 'The app process did not expose a PID after spawn.',
      };
    }
    child.unref();
    const metadata = metadataFromPlan(options, paths, plan, child.pid, options.platform ?? process.platform);
    writeFileSync(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return {
      ok: true,
      command: 'run start',
      dryRun: false,
      name: metadata.name,
      commandLine: metadata.command,
      cwd: metadata.cwd,
      pid: metadata.pid,
      paths,
      spawnPlan: plan,
      status: 'running',
      nextAction: `Run \`aie run wait --name ${metadata.name} --url <url> --timeout ${DEFAULT_TIMEOUT_SECONDS}\` to perform one bounded readiness wait.`,
    };
  } catch (err: unknown) {
    safeClose(stdout);
    safeClose(stderr);
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      command: 'run start',
      dryRun: false,
      name: validateName(options.name),
      commandLine: [plan.command, ...plan.args],
      cwd: plan.cwd,
      pid: null,
      paths,
      spawnPlan: plan,
      status: 'missing',
      nextAction: 'Fix the app command or working directory, inspect captured logs if present, then retry once.',
      error,
    };
  }
}

async function fetchReady(fetchImpl: typeof fetch, url: string): Promise<{ ready: boolean; httpStatus: number | null; error?: string }> {
  try {
    const response = await fetchImpl(url);
    return { ready: response.status >= 200 && response.status < 500, httpStatus: response.status };
  } catch (err: unknown) {
    return { ready: false, httpStatus: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runWait(options: RunWaitOptions): Promise<RunWaitResult> {
  const paths = runPaths(options.repoRoot, options.name);
  const metadata = readRunMetadata(options.repoRoot, options.name);
  const timeoutSeconds = Math.max(1, Math.trunc(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
  const pollIntervalMs = Math.max(100, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  if (!metadata) {
    return {
      ok: false,
      command: 'run wait',
      name: validateName(options.name),
      url: options.url,
      timeoutSeconds,
      elapsedMs: 0,
      attempts: 0,
      status: 'missing-run',
      httpStatus: null,
      paths,
      logTail: logTail(paths),
      nextAction: `Start the app first with \`aie run start --name ${options.name} -- <command>\`.`,
      error: `No run metadata exists for "${options.name}".`,
    };
  }
  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | undefined;
  while (clock() - started <= timeoutSeconds * 1000) {
    if (processState(metadata.pid) !== 'running') {
      return {
        ok: false,
        command: 'run wait',
        name: metadata.name,
        url: options.url,
        timeoutSeconds,
        elapsedMs: clock() - started,
        attempts,
        status: 'stopped',
        httpStatus: lastStatus,
        paths,
        logTail: logTail(paths),
        nextAction: 'Inspect stdout/stderr logs, fix the startup command, and rerun `aie run start` once.',
        error: `Run "${metadata.name}" stopped before readiness succeeded.`,
      };
    }
    attempts += 1;
    const result = await fetchReady(options.fetchImpl ?? fetch, options.url);
    lastStatus = result.httpStatus;
    lastError = result.error;
    if (result.ready) {
      return {
        ok: true,
        command: 'run wait',
        name: metadata.name,
        url: options.url,
        timeoutSeconds,
        elapsedMs: clock() - started,
        attempts,
        status: 'ready',
        httpStatus: result.httpStatus,
        paths,
        logTail: logTail(paths),
        nextAction: 'Proceed with browser inspection. Stop the app with `aie run stop --name <name>` when finished.',
      };
    }
    await delay(pollIntervalMs);
  }
  return {
    ok: false,
    command: 'run wait',
    name: metadata.name,
    url: options.url,
    timeoutSeconds,
    elapsedMs: clock() - started,
    attempts,
    status: 'timeout',
    httpStatus: lastStatus,
    paths,
    logTail: logTail(paths),
    nextAction: 'Inspect the captured stdout/stderr tails, fix the startup blocker, and retry with one bounded wait.',
    error: lastError ? `Timed out waiting for ${options.url}: ${lastError}` : `Timed out waiting for ${options.url}.`,
  };
}

function killProcessTree(pid: number, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    return result.status === 0;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

export function runStop(options: RunStopOptions): RunStopResult {
  const paths = runPaths(options.repoRoot, options.name);
  const metadata = readRunMetadata(options.repoRoot, options.name);
  const status = statusFromMetadata(metadata);
  if (!metadata) {
    return {
      ok: true,
      command: 'run stop',
      dryRun: options.dryRun === true,
      name: validateName(options.name),
      status: 'missing',
      pid: null,
      paths,
      logTail: logTail(paths),
      nextAction: `No process metadata exists for "${options.name}".`,
    };
  }
  if (options.dryRun) {
    return {
      ok: true,
      command: 'run stop',
      dryRun: true,
      name: metadata.name,
      status,
      pid: metadata.pid,
      paths,
      logTail: logTail(paths),
      nextAction: `Rerun without --dry-run to stop PID ${metadata.pid} and remove metadata.`,
    };
  }
  const stopped = status !== 'running' || killProcessTree(metadata.pid, options.platform ?? process.platform);
  if (stopped) {
    rmSync(paths.metadataPath, { force: true });
  }
  return {
    ok: stopped,
    command: 'run stop',
    dryRun: false,
    name: metadata.name,
    status: stopped ? 'stopped' : 'unknown',
    pid: metadata.pid,
    paths,
    logTail: logTail(paths),
    nextAction: stopped ? 'Runner metadata was removed. Inspect logs if startup or audit behavior needs review.' : 'Stop the process manually, then remove stale runner metadata.',
    ...(stopped ? {} : { error: `Failed to stop PID ${metadata.pid}.` }),
  };
}

export function formatRunResult(result: RunStartResult | RunStatusResult | RunWaitResult | RunStopResult): string {
  const lines: string[] = [];
  if (result.command === 'run start') {
    lines.push(`Run start ${result.name}: ${result.ok ? (result.dryRun ? 'planned' : 'started') : 'blocked'}.`);
    lines.push(`Command: ${result.commandLine.join(' ')}`);
    lines.push(`Working directory: ${result.cwd}`);
    if (result.pid) lines.push(`PID: ${result.pid}`);
    lines.push(`Logs: ${result.paths.stdoutPath} / ${result.paths.stderrPath}`);
  } else if (result.command === 'run status') {
    lines.push(`Run status ${result.name}: ${result.status}.`);
    if (result.metadata) {
      lines.push(`PID: ${result.metadata.pid}`);
      lines.push(`Command: ${result.metadata.command.join(' ')}`);
      lines.push(`Working directory: ${result.metadata.cwd}`);
    }
  } else if (result.command === 'run wait') {
    lines.push(`Run wait ${result.name}: ${result.status}.`);
    lines.push(`URL: ${result.url}`);
    lines.push(`Attempts: ${result.attempts}; elapsed: ${result.elapsedMs}ms; HTTP: ${result.httpStatus ?? 'none'}`);
  } else {
    lines.push(`Run stop ${result.name}: ${result.status}.`);
    if (result.pid) lines.push(`PID: ${result.pid}`);
  }
  if ('error' in result && result.error) lines.push(`Error: ${result.error}`);
  if ('logTail' in result) {
    if (result.logTail.stdout.length > 0) lines.push('stdout tail:', ...result.logTail.stdout.map(line => `  ${line}`));
    if (result.logTail.stderr.length > 0) lines.push('stderr tail:', ...result.logTail.stderr.map(line => `  ${line}`));
  }
  lines.push(`Next action: ${result.nextAction}`);
  return `${lines.join('\n')}\n`;
}
