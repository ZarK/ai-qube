import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DETACHED_PROCESS = 0x00000008;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const WINDOWS_SUPERVISOR_FLAGS = DETACHED_PROCESS
  | CREATE_NEW_PROCESS_GROUP
  | CREATE_UNICODE_ENVIRONMENT
  | CREATE_BREAKAWAY_FROM_JOB;
const SUPERVISOR_POLL_MS = 50;

export interface WindowsSupervisorLaunch {
  ownerPid: number;
}

export interface WindowsSupervisorResult {
  version: 1;
  token: string;
  phase: 'running' | 'failed' | 'stopped';
  ownerPid: number;
  rootPid: number | null;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function base64Text(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeExpression(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Text(value)}'))`;
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  return `${quoted}"`;
}

function parseLaunchOutput(output: string): WindowsSupervisorLaunch | null {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index] ?? '');
      if (!isRecord(parsed) || parsed.returnValue !== 0 || typeof parsed.processId !== 'number' || parsed.processId <= 0) continue;
      return { ownerPid: parsed.processId };
    } catch {
      // PowerShell can emit non-JSON host diagnostics before the final result.
    }
  }
  return null;
}

export function launchWindowsSupervisor(input: {
  nodePath: string;
  supervisorPath: string;
  manifestPath: string;
  token: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): WindowsSupervisorLaunch {
  const commandLine = [
    input.nodePath,
    input.supervisorPath,
    '--manifest',
    input.manifestPath,
    '--token',
    input.token,
  ].map(quoteWindowsArgument).join(' ');
  const script = [
    `$commandLine = ${decodeExpression(commandLine)}`,
    `$currentDirectory = ${decodeExpression(input.cwd)}`,
    '$environmentVariables = [string[]]@(Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })',
    `$startup = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]${WINDOWS_SUPERVISOR_FLAGS}; EnvironmentVariables = $environmentVariables } -ClientOnly`,
    '$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $currentDirectory; ProcessStartupInformation = $startup }',
    '[pscustomobject]@{ returnValue = [int]$created.ReturnValue; processId = [int]$created.ProcessId } | ConvertTo-Json -Compress',
    'if ($created.ReturnValue -ne 0) { exit 1 }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)], {
    cwd: input.cwd,
    env: input.env,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const launch = parseLaunchOutput(result.stdout);
  if (result.status !== 0 || !launch) {
    const detail = result.error?.message
      ?? result.stderr.trim()
      ?? result.stdout.trim()
      ?? `Win32_Process.Create exited with status ${result.status ?? 'unknown'}`;
    throw new Error(`Windows supervisor launch failed: ${detail}`);
  }
  return launch;
}

export function readWindowsSupervisorResult(path: string, token: string): WindowsSupervisorResult | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || parsed.token !== token
      || !['running', 'failed', 'stopped'].includes(String(parsed.phase))
      || typeof parsed.ownerPid !== 'number'
      || (parsed.rootPid !== null && typeof parsed.rootPid !== 'number')
      || (parsed.error !== undefined && typeof parsed.error !== 'string')
    ) {
      return null;
    }
    return parsed as unknown as WindowsSupervisorResult;
  } catch {
    return null;
  }
}

export async function waitForWindowsSupervisorResult(
  path: string,
  token: string,
  timeoutMs: number,
): Promise<WindowsSupervisorResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = readWindowsSupervisorResult(path, token);
    if (result) return result;
    await delay(SUPERVISOR_POLL_MS);
  }
  return null;
}
