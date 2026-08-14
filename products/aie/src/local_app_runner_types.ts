export type RunCommand = 'run start' | 'run wait' | 'run status' | 'run stop';
export type RunStatusState = 'missing' | 'running' | 'stopped' | 'unknown';

export interface AttemptLogPaths {
  attemptId: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface RunMetadata {
  version: 1;
  name: string;
  pid: number;
  command: string[];
  cwd: string;
  startedAt: string;
  platform: NodeJS.Platform;
  attemptId?: string;
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
}

export interface RunPaths {
  directory: string;
  metadataPath: string;
  currentAttemptPath: string;
  attemptId: string | null;
  stdoutPath: string;
  stderrPath: string;
  historicalLogs: AttemptLogPaths[];
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
  attemptId: string | null;
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
  attemptId: string | null;
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
  attemptId: string | null;
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
  attemptId: string | null;
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
  attemptId?: string;
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
