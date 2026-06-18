import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import type { RunMetadata, RunStatusState } from './local_app_runner_types.js';

interface ProcessIdentity {
  state: RunStatusState;
  commandLine: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pidState(pid: number): RunStatusState {
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (err: unknown) {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : '';
    return code === 'ESRCH' ? 'stopped' : 'unknown';
  }
}

function normalizeExecutableName(value: string): string {
  return basename(value).toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/i, '');
}

function commandLineForPid(pid: number, platform: NodeJS.Platform): string | null {
  if (pid === process.pid) return `"${process.execPath}" ${process.argv.slice(1).join(' ')}`;
  if (platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    const output = result.stdout.trim();
    return result.status === 0 && output ? output : null;
  }
  if (platform === 'linux') {
    try {
      const output = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      return output || null;
    } catch {
      return null;
    }
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
  const output = result.stdout.trim();
  return result.status === 0 && output ? output : null;
}

function commandLineExecutableName(commandLine: string): string {
  const trimmed = commandLine.trim();
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/);
  const windowsExecutable = trimmed.match(/^(.+?\.(?:cmd|exe|ps1|bat))(?=\s|$)/i);
  const executable = quoted?.[1] ?? windowsExecutable?.[1] ?? trimmed.split(/\s+/, 1)[0] ?? '';
  return normalizeExecutableName(executable);
}

export function processIdentity(metadata: RunMetadata, platform = process.platform): ProcessIdentity {
  const state = pidState(metadata.pid);
  if (state !== 'running') return { state, commandLine: null };
  const commandLine = commandLineForPid(metadata.pid, platform);
  if (!commandLine) return { state: 'unknown', commandLine: null };
  const expected = normalizeExecutableName(metadata.command[0] ?? '');
  const actual = commandLineExecutableName(commandLine);
  return expected && actual === expected ? { state: 'running', commandLine } : { state: 'unknown', commandLine };
}
