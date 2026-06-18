import { readFile } from "node:fs/promises";

import type {
  BashRunnerRuntime,
  DotNetRunnerRuntime,
  GoRunnerRuntime,
  HashicorpRunnerRuntime,
  JavaScriptRunnerRuntime,
  JvmRunnerRuntime,
  PowerShellRunnerRuntime,
  PythonRunnerRuntime,
  RustRunnerRuntime,
  TypeScriptRunnerRuntime,
} from "./languages/contracts.js";
import {
  getCachedRunnerValue,
  getRunnerGraph,
  getRunnerRunScopedValue,
  getRunnerSelectedStages,
  setRunnerRunScopedValue,
} from "./runner-context.js";
import { isSharedMetricsSupportedFile, shouldSkipScriptProjectDirectory } from "./runner-file-rules.js";
import {
  createExecutionFailureStage,
  createNoopStageResult,
  createNotImplementedStageResult,
  createProcessFailureDiagnostic,
  createSharedMetricsNotImplementedNote,
  createToolRunResult,
  readSharedMetricsNote,
} from "./runner-results.js";
import {
  createJvmProcessEnv,
  createRustProcessEnv,
  createUnsupportedJavaScriptRunnerNote,
  findFirstFile,
  findMatchingFiles,
  isMissingCommandOutcome,
  joinOutputs,
  readProcessFailureMessage,
  resolveBinaryIfAvailable,
  resolveDotNetCommand,
  resolveGradleCommand,
  resolveInstalledBinary,
  resolveMavenCommand,
  resolvePowerShellModuleManifest,
  resolveRequiredBinary,
  resolveRequiredPowerShellModuleManifest,
  resolveUvxCommand,
  runExecutable,
  runNodeTool,
  runPowerShellScript,
  throwIfAbortError,
} from "./runner-toolbox.js";

export function createTypeScriptRunnerRuntime(cwd: string, signal: AbortSignal | undefined) {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createToolRunResult,
    cwd,
    graph: getRunnerGraph(),
    joinOutputs,
    readProcessFailureMessage,
    runNodeTool,
    signal,
    throwIfAbortError,
  };
}

export function createJavaScriptRunnerRuntime(cwd: string, signal: AbortSignal | undefined) {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createSharedMetricsNotImplementedNote,
    createToolRunResult,
    cwd,
    findMatchingFiles,
    getCachedValue: getCachedRunnerValue,
    getRunScopedValue: getRunnerRunScopedValue,
    graph: getRunnerGraph(),
    isSharedMetricsCompanionFile: isSharedMetricsSupportedFile,
    readProcessFailureMessage,
    readSharedMetricsNote,
    readUnsupportedRunnerNote: createUnsupportedJavaScriptRunnerNote,
    resolveUvxCommand,
    runExecutable,
    selectedStages: getRunnerSelectedStages(),
    setRunScopedValue: setRunnerRunScopedValue,
    shouldSkipProjectDirectory: shouldSkipScriptProjectDirectory,
    signal,
    throwIfAbortError,
  };
}

export function createPythonRunnerRuntime(
  cwd: string,
  signal: AbortSignal | undefined,
): PythonRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createSharedMetricsNotImplementedNote,
    createToolRunResult,
    cwd,
    findMatchingFiles,
    getCachedValue: getCachedRunnerValue,
    getRunScopedValue: getRunnerRunScopedValue,
    graph: getRunnerGraph(),
    isSharedMetricsCompanionFile: isSharedMetricsSupportedFile,
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveBinaryIfAvailable,
    resolveRequiredBinary,
    runExecutable,
    selectedStages: getRunnerSelectedStages(),
    setRunScopedValue: setRunnerRunScopedValue,
    shouldSkipProjectDirectory: shouldSkipScriptProjectDirectory,
    signal,
    throwIfAbortError,
  };
}

export function createHashicorpRunnerRuntime(
  cwd: string,
  signal: AbortSignal | undefined,
): HashicorpRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createToolRunResult,
    cwd,
    getCachedValue: getCachedRunnerValue,
    graph: getRunnerGraph(),
    readProcessFailureMessage,
    resolveBinaryIfAvailable,
    resolveRequiredBinary,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

export function createGoRunnerRuntime(cwd: string, signal: AbortSignal | undefined): GoRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createSharedMetricsNotImplementedNote,
    createToolRunResult,
    cwd,
    findMatchingFiles,
    getCachedValue: getCachedRunnerValue,
    graph: getRunnerGraph(),
    isSharedMetricsCompanionFile: isSharedMetricsSupportedFile,
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveInstalledBinary,
    resolveUvxCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

export function createBashRunnerRuntime(cwd: string, signal: AbortSignal | undefined): BashRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createToolRunResult,
    cwd,
    findFirstFile,
    findMatchingFiles,
    graph: getRunnerGraph(),
    isMissingCommandOutcome,
    readProcessFailureMessage,
    resolveBinaryIfAvailable,
    resolveRequiredBinary,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

export function createPowerShellRunnerRuntime(
  cwd: string,
  signal: AbortSignal | undefined,
): PowerShellRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createToolRunResult,
    cwd,
    findMatchingFiles,
    graph: getRunnerGraph(),
    readProcessFailureMessage,
    resolvePowerShellModuleManifest,
    resolveRequiredPowerShellModuleManifest,
    runPowerShellScript,
    signal,
    throwIfAbortError,
  };
}

export function createRustRunnerRuntime(cwd: string, signal: AbortSignal | undefined): RustRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createRustProcessEnv,
    createSharedMetricsNotImplementedNote,
    createToolRunResult,
    cwd,
    findMatchingFiles,
    getCachedValue: getCachedRunnerValue,
    graph: getRunnerGraph(),
    isSharedMetricsCompanionFile: isSharedMetricsSupportedFile,
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveInstalledBinary,
    resolveUvxCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

export function createJvmRunnerRuntime(cwd: string, signal: AbortSignal | undefined): JvmRunnerRuntime {
  return {
    createExecutionFailureStage,
    createJvmProcessEnv,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createSharedMetricsNotImplementedNote,
    createToolRunResult,
    cwd,
    findFirstFile,
    findMatchingFiles,
    getCachedValue: getCachedRunnerValue,
    graph: getRunnerGraph(),
    isMissingCommandOutcome,
    isSharedMetricsCompanionFile: isSharedMetricsSupportedFile,
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveGradleCommand,
    resolveInstalledBinary,
    resolveMavenCommand,
    resolveUvxCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

export function createDotNetRunnerRuntime(
  cwd: string,
  signal: AbortSignal | undefined,
): DotNetRunnerRuntime {
  return {
    createExecutionFailureStage,
    createNoopStageResult,
    createNotImplementedStageResult,
    createProcessFailureDiagnostic,
    createSharedMetricsNotImplementedNote,
    createToolRunResult,
    cwd,
    getCachedValue: getCachedRunnerValue,
    graph: getRunnerGraph(),
    isSharedMetricsCompanionFile: isSharedMetricsSupportedFile,
    readFileText: (filePath) => readFile(filePath, "utf8"),
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveDotNetCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

