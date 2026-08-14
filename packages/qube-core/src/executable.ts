import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type ExecutableLookupStatus = "found" | "missing" | "unresolvable";
export type ExecutableLookupReason = "found" | "missing" | "empty-command" | "invalid-command";
export type ExecutableProbeStatus = "ok" | "present-but-failing" | "not-probed";

export interface ResolveExecutableOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathDelimiter?: string;
}

export interface ExecutableLookup {
  readonly command: string;
  readonly status: ExecutableLookupStatus;
  readonly resolvedPath: string | null;
  readonly reasonCode: ExecutableLookupReason;
}

export interface ProbeExecutableOptions extends ResolveExecutableOptions {
  readonly probeArgs?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ExecutableProbeResult extends ExecutableLookup {
  readonly probeStatus: ExecutableProbeStatus;
  readonly probeExitCode: number | null;
}

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function resolveExecutable(command: string, options: ResolveExecutableOptions = {}): ExecutableLookup {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { command, status: "unresolvable", resolvedPath: null, reasonCode: "empty-command" };
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    return { command: trimmed, status: "unresolvable", resolvedPath: null, reasonCode: "invalid-command" };
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const windows = isWindowsLookup(platform, env);
  const delimiter = options.pathDelimiter ?? (windows ? ";" : ":");
  const names = candidateNames(trimmed, env, windows);
  for (const entry of uniquePathEntries(env.PATH ?? "", delimiter, windows)) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (isResolvableFile(candidate, windows)) {
        return { command: trimmed, status: "found", resolvedPath: candidate, reasonCode: "found" };
      }
    }
  }
  return { command: trimmed, status: "missing", resolvedPath: null, reasonCode: "missing" };
}

export function probeExecutable(command: string, options: ProbeExecutableOptions = {}): ExecutableProbeResult {
  const lookup = resolveExecutable(command, options);
  if (lookup.status !== "found" || !lookup.resolvedPath) {
    return { ...lookup, probeStatus: "not-probed", probeExitCode: null };
  }
  const probeArgs = options.probeArgs ?? ["--help"];
  const invoked = spawnSync(lookup.resolvedPath, [...probeArgs], {
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 10_000,
    windowsHide: true,
    shell: usesWindowsShell(lookup.resolvedPath),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (invoked.error || invoked.status !== 0) {
    return {
      ...lookup,
      probeStatus: "present-but-failing",
      probeExitCode: invoked.status ?? null,
    };
  }
  return { ...lookup, probeStatus: "ok", probeExitCode: 0 };
}

export function executableExistsOnPath(command: string, options: ResolveExecutableOptions = {}): boolean {
  return resolveExecutable(command, options).status === "found";
}

function isWindowsLookup(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === "win32" || String(env.OS ?? "").toLowerCase().includes("windows");
}

function uniquePathEntries(pathValue: string, delimiter: string, windows: boolean): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of pathValue.split(delimiter)) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const key = windows ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function candidateNames(command: string, env: NodeJS.ProcessEnv, windows: boolean): readonly string[] {
  if (!windows) return [command];
  const extensions = pathExtEntries(env);
  const currentExt = path.extname(command);
  if (currentExt && extensions.some(extension => extension.toLowerCase() === currentExt.toLowerCase())) {
    return [command];
  }
  return [...extensions.map(extension => `${command}${extension}`), command];
}

function pathExtEntries(env: NodeJS.ProcessEnv): string[] {
  const configured = env.PATHEXT;
  const source = configured === undefined || configured.trim() === "" ? DEFAULT_WINDOWS_PATHEXT : configured;
  return source
    .split(";")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function isResolvableFile(candidate: string, windows: boolean): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (windows) return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function usesWindowsShell(resolvedPath: string): boolean {
  return [".cmd", ".bat"].includes(path.extname(resolvedPath).toLowerCase());
}
