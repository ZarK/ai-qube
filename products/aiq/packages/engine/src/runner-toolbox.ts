import { readdir } from "node:fs/promises";
import path from "node:path";

import type { StageId } from "./contracts.js";
import { getRunnerExecutionContext, getRunnerToolRunner } from "./runner-context.js";
import { AiqEngineCancelledError } from "./run.js";
import * as binaries from "./tools/binary-resolver.js";
import { pathExists } from "./utils/path-utils.js";

export async function findFirstFile(
  directory: string,
  predicate: (filePath: string) => boolean,
): Promise<string | undefined> {
  if (!(await pathExists(directory))) {
    return undefined;
  }

  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(entryPath, predicate);
      if (nested !== undefined) {
        return nested;
      }
      continue;
    }
    if (entry.isFile() && predicate(entryPath)) {
      return entryPath;
    }
  }

  return undefined;
}

export async function findMatchingFiles(
  root: string,
  predicate: (filePath: string) => boolean,
  shouldSkipDirectory: (directoryPath: string) => boolean = () => false,
): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const matches: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entryPath)) {
        continue;
      }
      matches.push(...(await findMatchingFiles(entryPath, predicate, shouldSkipDirectory)));
      continue;
    }
    if (entry.isFile() && predicate(entryPath)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

export async function measureOperation<T>(operation: () => Promise<T>): Promise<{
  durationMs: number;
  finishedAt: string;
  result: T;
  startedAt: string;
}> {
  const startedAt = new Date();
  const result = await operation();
  const finishedAt = new Date();

  return {
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    finishedAt: finishedAt.toISOString(),
    result,
    startedAt: startedAt.toISOString(),
  };
}

export function resolveMavenCommand(): string {
  return binaries.resolveMavenCommand();
}

export function resolveGradleCommand(): string {
  return binaries.resolveGradleCommand();
}

export async function resolveInstalledBinary(commandName: string): Promise<string | undefined> {
  return getRunnerToolRunner().resolveInstalledBinary(commandName);
}

export async function resolveBinaryIfAvailable(
  commandNames: readonly string[],
): Promise<string | undefined> {
  return getRunnerToolRunner().resolveBinaryIfAvailable(commandNames);
}

export async function resolveRequiredBinary(
  commandNames: readonly string[],
  toolName: string,
  installMessage: string,
): Promise<string> {
  return getRunnerToolRunner().resolveRequiredBinary(commandNames, toolName, installMessage);
}

export async function resolvePowerShellModuleManifest(
  moduleName: string,
): Promise<string | undefined> {
  return getRunnerToolRunner().resolvePowerShellModuleManifest(moduleName);
}

export async function resolveRequiredPowerShellModuleManifest(moduleName: string): Promise<string> {
  return getRunnerToolRunner().resolveRequiredPowerShellModuleManifest(moduleName);
}

export async function runPowerShellScript(
  script: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  durationMs: number;
  exitCode: number | undefined;
  finishedAt: string;
  startedAt: string;
  stderr: string;
  stdout: string;
}> {
  return getRunnerToolRunner().runPowerShellScript(
    script,
    cwd,
    signal ?? getRunnerExecutionContext().signal,
  );
}

export function isMissingCommandOutcome(
  stderr: string,
  stdout: string,
  exitCode: number | undefined,
): boolean {
  return getRunnerToolRunner().isMissingCommandOutcome(stderr, stdout, exitCode);
}

export async function createRustProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  return getRunnerToolRunner().createRustProcessEnv();
}

export async function createJvmProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  return getRunnerToolRunner().createJvmProcessEnv();
}

export function resolveUvxCommand(): string {
  return binaries.resolveUvxCommand();
}

export function resolveDotNetCommand(): string {
  return binaries.resolveDotNetCommand();
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

export function createUnsupportedJavaScriptRunnerNote(
  stageId: StageId,
  projectRoots: readonly string[],
): string {
  if (projectRoots.length === 0) {
    return `No JavaScript or TypeScript project roots were detected for ${stageId}.`;
  }

  return `No supported JavaScript or TypeScript test runner was detected for ${stageId} in: ${projectRoots.join(", ")}.`;
}

export function filterFiles(
  files: readonly string[],
  supportedExtensions: ReadonlySet<string>,
): string[] {
  return files.filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()));
}

export async function findSharedNativeConfig(
  files: readonly string[],
  findConfig: (file: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const configPaths = new Set<string>();

  for (const file of files) {
    const configPath = await findConfig(file);
    if (configPath === undefined) {
      return undefined;
    }
    configPaths.add(configPath);
  }

  return configPaths.size === 1 ? [...configPaths][0] : undefined;
}

export function readProcessFailureMessage(
  toolName: string,
  stderr: string,
  stdout: string,
  exitCode: number | undefined,
): string {
  return getRunnerToolRunner().readProcessFailureMessage(toolName, stderr, stdout, exitCode);
}

export function joinOutputs(...values: string[]): string {
  return getRunnerToolRunner().joinOutputs(...values);
}

export function resolvePackageBinaryPath(
  packageJsonSpecifier: string,
  relativeBinaryPath: string,
): string {
  return binaries.resolvePackageBinaryPath(packageJsonSpecifier, relativeBinaryPath);
}

export async function runNodeTool(
  scriptPath: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  durationMs: number;
  exitCode: number | undefined;
  finishedAt: string;
  startedAt: string;
  stderr: string;
  stdout: string;
}> {
  return getRunnerToolRunner().runNodeTool(
    scriptPath,
    args,
    cwd,
    signal ?? getRunnerExecutionContext().signal,
  );
}

export async function runExecutable(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<{
  durationMs: number;
  exitCode: number | undefined;
  finishedAt: string;
  startedAt: string;
  stderr: string;
  stdout: string;
}> {
  const options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = { cwd };
  if (env !== undefined) {
    options.env = env;
  }
  const activeSignal = signal ?? getRunnerExecutionContext().signal;
  if (activeSignal !== undefined) {
    options.signal = activeSignal;
  }
  return getRunnerToolRunner().run(command, args, options);
}

export function isAbortError(error: unknown): boolean {
  return getRunnerToolRunner().isAbortError(error);
}

export function throwIfAbortError(error: unknown): void {
  if (isAbortError(error)) {
    throw new AiqEngineCancelledError();
  }
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
