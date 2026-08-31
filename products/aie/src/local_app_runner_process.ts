import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import type { RunMetadata, RunStatusState } from './local_app_runner_types.js';

export interface ProcessIdentity {
  state: RunStatusState;
  commandLine: string | null;
  ownedPids: number[];
}

export interface WindowsProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
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

function windowsProcessTree(ownerPid: number, rootPid?: number): WindowsProcessRecord[] | null {
  const script = [
    '$all = Get-CimInstance Win32_Process',
    `$pending = New-Object 'System.Collections.Generic.Queue[int]'; $pending.Enqueue(${ownerPid})${rootPid === undefined ? '' : `; $pending.Enqueue(${rootPid})`}`,
    '$seen = @{}; $tree = @()',
    'while ($pending.Count -gt 0) { $current = $pending.Dequeue(); if ($seen.ContainsKey($current)) { continue }; $seen[$current] = $true; $processValue = $all | Where-Object ProcessId -eq $current; if ($processValue) { $tree += $processValue; $all | Where-Object ParentProcessId -eq $current | ForEach-Object { $pending.Enqueue([int]$_.ProcessId) } } }',
    '$tree | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim() || '[]');
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const records: WindowsProcessRecord[] = [];
    for (const value of values) {
      if (
        !isRecord(value)
        || typeof value.ProcessId !== 'number'
        || typeof value.ParentProcessId !== 'number'
        || typeof value.Name !== 'string'
        || (value.CommandLine !== null && typeof value.CommandLine !== 'string')
      ) {
        return null;
      }
      records.push({
        pid: value.ProcessId,
        parentPid: value.ParentProcessId,
        name: value.Name,
        commandLine: value.CommandLine,
      });
    }
    return records;
  } catch {
    return null;
  }
}

function commandLineExecutableName(commandLine: string): string {
  const trimmed = commandLine.trim();
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/);
  const windowsExecutable = trimmed.match(/^(.+?\.(?:cmd|exe|ps1|bat))(?=\s|$)/i);
  const executable = quoted?.[1] ?? windowsExecutable?.[1] ?? trimmed.split(/\s+/, 1)[0] ?? '';
  return normalizeExecutableName(executable);
}

export function processIdentity(metadata: RunMetadata, platform = process.platform): ProcessIdentity {
  if (metadata.ownerKind === 'windows-supervisor') {
    if (platform !== 'win32') return { state: 'unknown', commandLine: null, ownedPids: [] };
    const records = windowsProcessTree(metadata.ownerPid, metadata.pid);
    if (!records) return { state: 'unknown', commandLine: null, ownedPids: [] };
    return classifyWindowsProcessTree(metadata, records);
  }
  const state = pidState(metadata.pid);
  if (state !== 'running') return { state, commandLine: null, ownedPids: [] };
  const commandLine = commandLineForPid(metadata.pid, platform);
  if (!commandLine) return { state: 'unknown', commandLine: null, ownedPids: [] };
  const expected = normalizeExecutableName(metadata.command[0] ?? '');
  const actual = commandLineExecutableName(commandLine);
  if (expected && actual === expected) return { state: 'running', commandLine, ownedPids: [metadata.pid] };
  if (expected && actual === 'cmd' && commandLineMentions(commandLine, expected)) {
    return { state: 'running', commandLine, ownedPids: [metadata.pid] };
  }
  return { state: 'unknown', commandLine, ownedPids: [] };
}

export function classifyWindowsProcessTree(metadata: RunMetadata, records: readonly WindowsProcessRecord[]): ProcessIdentity {
  const owner = records.find(record => record.pid === metadata.ownerPid);
  if (!owner) {
    const orphanedRoot = records.find(record => record.pid === metadata.pid);
    return orphanedRoot
      ? { state: 'unknown', commandLine: orphanedRoot.commandLine, ownedPids: [] }
      : { state: 'stopped', commandLine: null, ownedPids: [] };
  }
  if (
    !metadata.ownerToken
    || !metadata.supervisorPath
    || !metadata.launchManifestPath
    || !windowsOwnerMatches(owner, metadata.ownerToken, metadata.supervisorPath, metadata.launchManifestPath)
  ) {
    return { state: 'unknown', commandLine: owner.commandLine, ownedPids: [] };
  }
  const root = records.find(record => record.pid === metadata.pid);
  if (!root || root.parentPid !== metadata.ownerPid) {
    return { state: 'unknown', commandLine: owner.commandLine, ownedPids: [] };
  }
  if (metadata.requiresDescendant) {
    const descendants = descendantsOf(metadata.pid, records);
    const applicationDescendant = descendants.some(record => normalizeExecutableName(record.name) !== 'conhost');
    if (!applicationDescendant) {
      return { state: 'unknown', commandLine: owner.commandLine, ownedPids: [] };
    }
  }
  return {
    state: 'running',
    commandLine: root.commandLine,
    ownedPids: records.map(record => record.pid),
  };
}

export function windowsSupervisorMatches(
  ownerPid: number,
  token: string,
  supervisorPath: string,
  launchManifestPath: string,
): boolean {
  const records = windowsProcessTree(ownerPid);
  if (!records) return false;
  const owner = records.find(record => record.pid === ownerPid);
  return owner !== undefined && windowsOwnerMatches(owner, token, supervisorPath, launchManifestPath);
}

function windowsOwnerMatches(
  owner: WindowsProcessRecord,
  token: string,
  supervisorPath: string,
  launchManifestPath: string,
): boolean {
  return owner.commandLine !== null
    && commandLineExecutableName(owner.commandLine) === normalizeExecutableName(process.execPath)
    && normalizedCommandLineIncludes(owner.commandLine, supervisorPath)
    && normalizedCommandLineIncludes(owner.commandLine, launchManifestPath)
    && commandLineMentions(owner.commandLine, token.toLowerCase());
}

function descendantsOf(rootPid: number, records: readonly WindowsProcessRecord[]): WindowsProcessRecord[] {
  const descendants: WindowsProcessRecord[] = [];
  const pending = [rootPid];
  const seen = new Set<number>(pending);
  while (pending.length > 0) {
    const parentPid = pending.shift();
    if (parentPid === undefined) break;
    for (const record of records) {
      if (record.parentPid !== parentPid || seen.has(record.pid)) continue;
      seen.add(record.pid);
      descendants.push(record);
      pending.push(record.pid);
    }
  }
  return descendants;
}

function normalizedCommandLineIncludes(commandLine: string, value: string): boolean {
  const normalizedCommandLine = commandLine.replace(/\//gu, '\\').toLowerCase();
  const normalizedValue = value.replace(/\//gu, '\\').toLowerCase();
  return normalizedCommandLine.includes(normalizedValue);
}

function commandLineMentions(commandLine: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\\\/"'\\s])${escaped}(?:\\.(?:cmd|exe|bat|ps1))?(?:["'\\s]|$)`, 'i').test(commandLine);
}
