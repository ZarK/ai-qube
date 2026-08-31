import { appendFileSync, closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const EARLY_EXIT_WAIT_MS = 400;

interface SupervisorManifest {
  version: 1;
  token: string;
  command: string;
  args: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  windowsVerbatimArguments: boolean;
}

interface ChildOutcome {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function readManifest(path: string, token: string): SupervisorManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || parsed.token !== token
    || typeof parsed.command !== 'string'
    || !Array.isArray(parsed.args)
    || !parsed.args.every(argument => typeof argument === 'string')
    || typeof parsed.cwd !== 'string'
    || typeof parsed.stdoutPath !== 'string'
    || typeof parsed.stderrPath !== 'string'
    || typeof parsed.resultPath !== 'string'
    || typeof parsed.windowsVerbatimArguments !== 'boolean'
  ) {
    throw new Error('Windows supervisor launch manifest is malformed.');
  }
  return parsed as unknown as SupervisorManifest;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    renameSync(temporaryPath, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(temporaryPath, path);
  }
}

function writeResult(
  manifest: SupervisorManifest,
  phase: 'running' | 'failed' | 'stopped',
  rootPid: number | null,
  error?: string,
): void {
  writeJsonAtomic(manifest.resultPath, {
    version: 1,
    token: manifest.token,
    phase,
    ownerPid: process.pid,
    rootPid,
    ...(error ? { error } : {}),
  });
}

function recordError(manifest: SupervisorManifest, message: string): void {
  try {
    appendFileSync(manifest.stderrPath, `\n[aie-runner] supervisor error: ${message}\n`);
  } catch {
    // The result file remains the authoritative startup outcome.
  }
}

function closeDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // spawn can close duplicated descriptors before this process does.
  }
}

async function supervise(manifest: SupervisorManifest): Promise<void> {
  appendFileSync(manifest.stdoutPath, `[aie-runner] spawn ${manifest.command} ${manifest.args.join(' ')}\n`);
  const stdout = openSync(manifest.stdoutPath, 'a');
  const stderr = openSync(manifest.stderrPath, 'a');
  const child = spawn(manifest.command, manifest.args, {
    cwd: manifest.cwd,
    detached: false,
    windowsHide: true,
    windowsVerbatimArguments: manifest.windowsVerbatimArguments,
    shell: false,
    stdio: ['ignore', stdout, stderr],
  });
  closeDescriptor(stdout);
  closeDescriptor(stderr);
  if (!child.pid) {
    throw new Error('The app process did not expose a PID after spawn.');
  }
  const rootPid = child.pid;
  const lifetime = new Promise<ChildOutcome>(resolve => {
    let settled = false;
    const finish = (error: string) => {
      if (settled) return;
      settled = true;
      resolve({ error });
    };
    child.once('error', error => finish(error.message));
    child.once('exit', (code, signal) => {
      finish(`The app process exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`);
    });
  });
  const earlyOutcome = await Promise.race([
    lifetime,
    delay(EARLY_EXIT_WAIT_MS).then(() => null),
  ]);
  if (earlyOutcome) {
    recordError(manifest, earlyOutcome.error);
    writeResult(manifest, 'failed', rootPid, earlyOutcome.error);
    return;
  }
  writeResult(manifest, 'running', rootPid);
  const outcome = await lifetime;
  writeResult(manifest, 'stopped', rootPid, outcome.error);
}

async function main(): Promise<void> {
  let manifest: SupervisorManifest | null = null;
  try {
    const manifestPath = readArgument('--manifest');
    const token = readArgument('--token');
    manifest = readManifest(manifestPath, token);
    await supervise(manifest);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (manifest) {
      recordError(manifest, message);
      writeResult(manifest, 'failed', null, message);
    }
    process.exitCode = 1;
  }
}

void main();
