import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, extname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveExecutable } from '@tjalve/qube-core';
import { processIdentity } from './local_app_runner_process.js';
import type {
  AttemptLogPaths,
  RunMetadata,
  RunNameOptions,
  RunPaths,
  RunStartOptions,
  RunStartResult,
  RunStatusResult,
  RunStatusState,
  RunStopOptions,
  RunStopResult,
  RunWaitOptions,
  RunWaitResult,
  SpawnPlan,
} from './local_app_runner_types.js';

export { formatRunResult } from './local_app_runner_format.js';
export type {
  AttemptLogPaths,
  RunCommand,
  RunMetadata,
  RunNameOptions,
  RunPaths,
  RunStartOptions,
  RunStartResult,
  RunStatusResult,
  RunStatusState,
  RunStopOptions,
  RunStopResult,
  RunWaitOptions,
  RunWaitResult,
  SpawnPlan,
} from './local_app_runner_types.js';

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 500;
const LOG_TAIL_LINES = 30;
const SAFE_RUN_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9._-]+$/;
const LEGACY_ATTEMPT_ID = 'legacy';

interface CurrentAttempt {
  attemptId: string;
  stdoutPath: string;
  stderrPath: string;
  startedAt: string;
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!SAFE_RUN_NAME.test(normalized)) throw new Error(`run name must contain only letters, numbers, dot, underscore, or dash; received "${name}"`);
  return normalized;
}

function validateAttemptId(attemptId: string): string {
  const normalized = attemptId.trim();
  if (!SAFE_ATTEMPT_ID.test(normalized)) throw new Error(`run attempt id must contain only letters, numbers, dot, underscore, or dash; received "${attemptId}"`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    renameSync(temporaryPath, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(temporaryPath, path);
  }
}

function attemptFilePaths(directory: string, attemptId: string): AttemptLogPaths {
  if (attemptId === LEGACY_ATTEMPT_ID) {
    return {
      attemptId,
      stdoutPath: join(directory, 'stdout.log'),
      stderrPath: join(directory, 'stderr.log'),
    };
  }
  return {
    attemptId,
    stdoutPath: join(directory, `stdout-${attemptId}.log`),
    stderrPath: join(directory, `stderr-${attemptId}.log`),
  };
}

function listHistoricalLogs(directory: string): AttemptLogPaths[] {
  if (!existsSync(directory)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of names) {
    const match = name.match(/^(?:stdout|stderr)-(.+)\.log$/);
    if (match) ids.add(match[1]);
  }
  if (names.includes('stdout.log') || names.includes('stderr.log')) ids.add(LEGACY_ATTEMPT_ID);
  return [...ids].sort().map(attemptId => attemptFilePaths(directory, attemptId));
}

function createAttemptId(now: Date, existingIds: string[]): string {
  const base = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function readCurrentAttempt(path: string): CurrentAttempt | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.attemptId !== 'string' || typeof parsed.stdoutPath !== 'string' || typeof parsed.stderrPath !== 'string') {
      return null;
    }
    return {
      attemptId: parsed.attemptId,
      stdoutPath: parsed.stdoutPath,
      stderrPath: parsed.stderrPath,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

function writeCurrentAttempt(path: string, value: CurrentAttempt): void {
  writeJsonAtomic(path, { version: 1, ...value });
}

function baseRunPaths(repoRoot: string, name: string): Omit<RunPaths, 'attemptId' | 'stdoutPath' | 'stderrPath' | 'historicalLogs'> {
  const safeName = validateName(name);
  const directory = join(repoRoot, '.qube', 'aie', 'runs', safeName);
  return {
    directory,
    metadataPath: join(directory, 'metadata.json'),
    currentAttemptPath: join(directory, 'current-attempt.json'),
  };
}

function withLogPaths(
  base: Omit<RunPaths, 'attemptId' | 'stdoutPath' | 'stderrPath' | 'historicalLogs'>,
  attemptId: string | null,
  stdoutPath: string,
  stderrPath: string,
): RunPaths {
  const historicalLogs = listHistoricalLogs(base.directory);
  if (attemptId && !historicalLogs.some(entry => entry.attemptId === attemptId)) {
    historicalLogs.push({ attemptId, stdoutPath, stderrPath });
    historicalLogs.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  }
  return { ...base, attemptId, stdoutPath, stderrPath, historicalLogs };
}

export function runPaths(repoRoot: string, name: string, attemptId?: string): RunPaths {
  const base = baseRunPaths(repoRoot, name);
  if (attemptId) {
    const safeAttemptId = validateAttemptId(attemptId);
    const files = attemptFilePaths(base.directory, safeAttemptId);
    return withLogPaths(base, files.attemptId, files.stdoutPath, files.stderrPath);
  }
  if (existsSync(base.metadataPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(base.metadataPath, 'utf8'));
      if (isRecord(parsed) && typeof parsed.stdoutPath === 'string' && typeof parsed.stderrPath === 'string') {
        const metadataAttemptId = typeof parsed.attemptId === 'string' ? parsed.attemptId : null;
        return withLogPaths(base, metadataAttemptId, parsed.stdoutPath, parsed.stderrPath);
      }
    } catch {
      // Fall through to the current-attempt pointer or legacy files.
    }
  }
  const current = readCurrentAttempt(base.currentAttemptPath);
  if (current) return withLogPaths(base, current.attemptId, current.stdoutPath, current.stderrPath);
  const legacy = attemptFilePaths(base.directory, LEGACY_ATTEMPT_ID);
  return withLogPaths(base, null, legacy.stdoutPath, legacy.stderrPath);
}

function resolveWorkingDirectory(repoRoot: string, cwd: string | undefined): string {
  const input = cwd?.trim() || '.';
  return resolve(repoRoot, input);
}

function isWindowsPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function isWindowsLauncher(filePath: string): boolean {
  return ['.cmd', '.bat'].includes(extname(filePath).toLowerCase());
}

function quoteCmdArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildSpawnPlan(options: RunStartOptions, paths = runPaths(options.repoRoot, options.name)): SpawnPlan {
  if (options.command.length === 0) throw new Error('missing app command after `--`; example: aie run start --name ui-audit -- npm run dev');
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const requested = options.command[0];
  const lookup = resolveExecutable(requested, { env, platform });
  const resolved = lookup.resolvedPath ?? requested;
  const wrapLauncher = isWindowsPlatform(platform) && isWindowsLauncher(resolved);
  if (wrapLauncher) {
    const commandLine = [resolved, ...options.command.slice(1)].map(quoteCmdArgument).join(' ');
    const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      cwd: resolveWorkingDirectory(options.repoRoot, options.cwd),
      detached: true,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: true,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
    };
  }
  return {
    command: requested,
    args: options.command.slice(1),
    cwd: resolveWorkingDirectory(options.repoRoot, options.cwd),
    detached: true,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: false,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  };
}

function metadataFromPlan(options: RunStartOptions, paths: RunPaths, plan: SpawnPlan, pid: number, platform: NodeJS.Platform): RunMetadata {
  if (!paths.attemptId) throw new Error('run start requires an attempt id before writing metadata');
  return {
    version: 1,
    name: validateName(options.name),
    pid,
    command: options.command,
    cwd: plan.cwd,
    startedAt: (options.now ?? new Date()).toISOString(),
    platform,
    attemptId: paths.attemptId,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    metadataPath: paths.metadataPath,
  };
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

function statusFromMetadata(metadata: RunMetadata | null): RunStatusState {
  return metadata ? processIdentity(metadata).state : 'missing';
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

function recordSpawnError(stderrPath: string, message: string): void {
  try {
    mkdirSync(dirname(stderrPath), { recursive: true });
    appendFileSync(stderrPath, `\n[aie-runner] spawn error: ${message}\n`);
  } catch {
    // Status and wait still report empty tails when the attempt file cannot be written.
  }
}

function removeMetadataIfCurrentAttempt(metadataPath: string, attemptId: string): void {
  try {
    if (!existsSync(metadataPath)) return;
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (isRecord(parsed) && parsed.attemptId === attemptId) {
      rmSync(metadataPath, { force: true });
    }
  } catch {
    // Leave metadata in place when ownership cannot be confirmed.
  }
}

function safeClose(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The descriptor may already have been handed off and closed after spawn.
  }
}

function fallbackPaths(repoRoot: string, name: string): RunPaths {
  try {
    return runPaths(repoRoot, name);
  } catch {
    const directory = join(repoRoot, '.qube', 'aie', 'runs', 'unknown');
    return {
      directory,
      metadataPath: join(directory, 'metadata.json'),
      currentAttemptPath: join(directory, 'current-attempt.json'),
      attemptId: null,
      stdoutPath: join(directory, 'stdout.log'),
      stderrPath: join(directory, 'stderr.log'),
      historicalLogs: [],
    };
  }
}

export function runStatus(options: RunNameOptions): RunStatusResult {
  try {
    const paths = runPaths(options.repoRoot, options.name, options.attemptId);
    const metadata = readRunMetadata(options.repoRoot, options.name);
    const status = statusFromMetadata(metadata);
    return {
      ok: true,
      command: 'run status',
      name: validateName(options.name),
      status,
      attemptId: paths.attemptId,
      metadata,
      paths,
      logTail: logTail(paths),
      nextAction: options.attemptId && !existsSync(paths.stdoutPath) && !existsSync(paths.stderrPath)
        ? `No logs exist for attempt ${paths.attemptId}. Use \`aie run status --name ${options.name}\` for the current attempt.`
        : status === 'running'
          ? `Use \`aie run wait --name ${options.name} --url <url>\` or \`aie run stop --name ${options.name}\`.`
          : `Start the app with \`aie run start --name ${options.name} -- <command>\`.`,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const paths = fallbackPaths(options.repoRoot, options.name);
    return {
      ok: false,
      command: 'run status',
      name: options.name,
      status: 'unknown',
      attemptId: paths.attemptId,
      metadata: null,
      paths,
      logTail: logTail(paths),
      nextAction: 'Inspect or remove the malformed runner metadata, then retry the status command.',
      error,
    };
  }
}

export function runStart(options: RunStartOptions): RunStartResult {
  const existingPaths = runPaths(options.repoRoot, options.name);
  const existing = readRunMetadata(options.repoRoot, options.name);
  const existingStatus = statusFromMetadata(existing);
  if (existingStatus === 'running') {
    const plan = buildSpawnPlan(options, existingPaths);
    return {
      ok: false,
      command: 'run start',
      dryRun: options.dryRun === true,
      name: validateName(options.name),
      commandLine: options.command,
      cwd: plan.cwd,
      pid: existing?.pid ?? null,
      attemptId: existing?.attemptId ?? existingPaths.attemptId,
      paths: existingPaths,
      spawnPlan: plan,
      status: 'running',
      nextAction: `Stop the existing process with \`aie run stop --name ${options.name}\`, or choose a different --name.`,
      error: `Run "${options.name}" is already running with PID ${existing?.pid}.`,
    };
  }
  const attemptId = createAttemptId(options.now ?? new Date(), existingPaths.historicalLogs.map(entry => entry.attemptId));
  const paths = runPaths(options.repoRoot, options.name, attemptId);
  const plan = buildSpawnPlan(options, paths);
  if (options.dryRun) {
    return {
      ok: true,
      command: 'run start',
      dryRun: true,
      name: validateName(options.name),
      commandLine: options.command,
      cwd: plan.cwd,
      pid: null,
      attemptId,
      paths,
      spawnPlan: plan,
      status: 'missing',
      nextAction: `Rerun without --dry-run to start the app and write metadata under ${paths.directory}.`,
    };
  }

  mkdirSync(paths.directory, { recursive: true });
  const startedAt = (options.now ?? new Date()).toISOString();
  writeCurrentAttempt(paths.currentAttemptPath, {
    attemptId,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    startedAt,
  });
  if (existsSync(paths.metadataPath)) rmSync(paths.metadataPath, { force: true });
  const stdout = openSync(paths.stdoutPath, 'a');
  const stderr = openSync(paths.stderrPath, 'a');
  try {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: plan.detached,
      windowsHide: plan.windowsHide,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      shell: plan.shell,
      stdio: ['ignore', stdout, stderr],
    });
    safeClose(stdout);
    safeClose(stderr);
    child.once('error', err => {
      recordSpawnError(paths.stderrPath, err.message);
      removeMetadataIfCurrentAttempt(paths.metadataPath, attemptId);
    });
    if (!child.pid) {
      recordSpawnError(paths.stderrPath, 'The app process did not expose a PID after spawn.');
      return {
        ok: false,
        command: 'run start',
        dryRun: false,
        name: validateName(options.name),
        commandLine: options.command,
        cwd: plan.cwd,
        pid: null,
        attemptId,
        paths,
        spawnPlan: plan,
        status: 'missing',
        nextAction: 'Fix the app command or working directory, inspect captured logs if present, then retry once.',
        error: 'The app process did not expose a PID after spawn.',
      };
    }
    const metadata = metadataFromPlan(options, paths, plan, child.pid, options.platform ?? process.platform);
    try {
      writeJsonAtomic(paths.metadataPath, metadata);
    } catch (err: unknown) {
      child.kill();
      const error = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        command: 'run start',
        dryRun: false,
        name: validateName(options.name),
        commandLine: options.command,
        cwd: plan.cwd,
        pid: child.pid,
        attemptId,
        paths,
        spawnPlan: plan,
        status: 'unknown',
        nextAction: 'Fix runner metadata storage, verify no child process remains, then retry once.',
        error: `Failed to write runner metadata: ${error}`,
      };
    }
    child.unref();
    return {
      ok: true,
      command: 'run start',
      dryRun: false,
      name: metadata.name,
      commandLine: metadata.command,
      cwd: metadata.cwd,
      pid: metadata.pid,
      attemptId,
      paths,
      spawnPlan: plan,
      status: 'running',
      nextAction: `Run \`aie run wait --name ${metadata.name} --url <url> --timeout ${DEFAULT_TIMEOUT_SECONDS}\` to perform one bounded readiness wait.`,
    };
  } catch (err: unknown) {
    safeClose(stdout);
    safeClose(stderr);
    const error = err instanceof Error ? err.message : String(err);
    recordSpawnError(paths.stderrPath, error);
    return {
      ok: false,
      command: 'run start',
      dryRun: false,
      name: validateName(options.name),
      commandLine: options.command,
      cwd: plan.cwd,
      pid: null,
      attemptId,
      paths,
      spawnPlan: plan,
      status: 'missing',
      nextAction: 'Fix the app command or working directory, inspect captured logs if present, then retry once.',
      error,
    };
  }
}

function requestReady(url: URL, hostname: string, family?: 4 | 6): Promise<{ ready: boolean; httpStatus: number | null; error?: string }> {
  const lib = url.protocol === 'https:' ? https : http;
  const port = url.port !== '' ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  return new Promise(resolve => {
    const request = lib.request({
      hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      family,
      timeout: 2000,
      headers: { Host: url.host },
      servername: url.hostname,
    }, response => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve({ ready: status >= 200 && status < 500, httpStatus: status });
    });
    request.on('error', error => {
      resolve({ ready: false, httpStatus: null, error: error instanceof Error ? error.message : String(error) });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ready: false, httpStatus: null, error: `Timed out connecting to ${url.href}` });
    });
    request.end();
  });
}

async function probeReady(url: string): Promise<{ ready: boolean; httpStatus: number | null; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err: unknown) {
    return { ready: false, httpStatus: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0') {
    return requestReady(parsed, parsed.hostname, 4);
  }
  if (parsed.hostname === '::1' || parsed.hostname === '[::1]') {
    return requestReady(parsed, '::1', 6);
  }
  try {
    const addresses = await dnsLookup(parsed.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return requestReady(parsed, parsed.hostname);
    let lastError: string | undefined;
    let lastStatus: number | null = null;
    for (const entry of addresses) {
      const family = entry.family === 6 ? 6 : entry.family === 4 ? 4 : undefined;
      const result = await requestReady(parsed, entry.address, family);
      if (result.ready) return result;
      lastError = result.error;
      lastStatus = result.httpStatus;
    }
    return { ready: false, httpStatus: lastStatus, error: lastError };
  } catch (err: unknown) {
    return requestReady(parsed, parsed.hostname);
  }
}

async function fetchReady(fetchImpl: typeof fetch | undefined, url: string): Promise<{ ready: boolean; httpStatus: number | null; error?: string }> {
  if (fetchImpl) {
    try {
      const response = await fetchImpl(url);
      return { ready: response.status >= 200 && response.status < 500, httpStatus: response.status };
    } catch (err: unknown) {
      return { ready: false, httpStatus: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return probeReady(url);
}

function isLocalReadinessUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export async function runWait(options: RunWaitOptions): Promise<RunWaitResult> {
  const paths = runPaths(options.repoRoot, options.name, options.attemptId);
  const metadata = readRunMetadata(options.repoRoot, options.name);
  const timeoutSeconds = Math.max(1, Math.trunc(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
  const pollIntervalMs = Math.max(100, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  if (!isLocalReadinessUrl(options.url)) {
    return {
      ok: false,
      command: 'run wait',
      name: validateName(options.name),
      url: options.url,
      timeoutSeconds,
      elapsedMs: 0,
      attempts: 0,
      attemptId: paths.attemptId,
      status: 'request-failed',
      httpStatus: null,
      paths,
      logTail: logTail(paths),
      nextAction: 'Use a local readiness URL such as http://127.0.0.1:3000 or http://localhost:5173.',
      error: `Refusing non-local readiness URL: ${options.url}`,
    };
  }
  if (!metadata) {
    return {
      ok: false,
      command: 'run wait',
      name: validateName(options.name),
      url: options.url,
      timeoutSeconds,
      elapsedMs: 0,
      attempts: 0,
      attemptId: paths.attemptId,
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
    if (processIdentity(metadata).state !== 'running') {
      return {
        ok: false,
        command: 'run wait',
        name: metadata.name,
        url: options.url,
        timeoutSeconds,
        elapsedMs: clock() - started,
        attempts,
        attemptId: paths.attemptId,
        status: 'stopped',
        httpStatus: lastStatus,
        paths,
        logTail: logTail(paths),
        nextAction: 'Inspect stdout/stderr logs, fix the startup command, and rerun `aie run start` once.',
        error: `Run "${metadata.name}" stopped before readiness succeeded.`,
      };
    }
    attempts += 1;
    const result = await fetchReady(options.fetchImpl, options.url);
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
        attemptId: paths.attemptId,
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
    attemptId: paths.attemptId,
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
  const paths = runPaths(options.repoRoot, options.name, options.attemptId);
  const metadata = readRunMetadata(options.repoRoot, options.name);
  const status = metadata ? processIdentity(metadata, options.platform ?? process.platform).state : 'missing';
  if (!metadata) {
    return {
      ok: true,
      command: 'run stop',
      dryRun: options.dryRun === true,
      name: validateName(options.name),
      status: 'missing',
      attemptId: paths.attemptId,
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
      attemptId: paths.attemptId,
      pid: metadata.pid,
      paths,
      logTail: logTail(paths),
      nextAction: `Rerun without --dry-run to stop PID ${metadata.pid} and remove metadata.`,
    };
  }
  const stopped = status === 'stopped' || (status === 'running' && killProcessTree(metadata.pid, options.platform ?? process.platform));
  if (stopped) {
    rmSync(paths.metadataPath, { force: true });
  }
  return {
    ok: stopped,
    command: 'run stop',
    dryRun: false,
    name: metadata.name,
    status: stopped ? 'stopped' : 'unknown',
    attemptId: paths.attemptId,
    pid: metadata.pid,
    paths,
    logTail: logTail(paths),
    nextAction: stopped ? 'Runner metadata was removed. Inspect logs if startup or audit behavior needs review.' : 'Stop the process manually, then remove stale runner metadata.',
    ...(stopped ? {} : { error: `Failed to stop PID ${metadata.pid}.` }),
  };
}
