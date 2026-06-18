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
