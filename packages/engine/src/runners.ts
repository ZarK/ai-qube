import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { Parser as SqlParserClass } from "node-sql-parser";
import * as prettier from "prettier";
import stylelint from "stylelint";
import { parseAllDocuments } from "yaml";

import { createCacheService } from "./cache.js";
import type {
  CacheService,
  Diagnostic,
  EngineContext,
  LanguageId,
  PlannedTask,
  ProjectGraph,
  RunStageConfiguration,
  RunStageConfigurations,
  StageId,
  StageResult,
  ToolRunResult,
  ToolRunStatus,
} from "./contracts.js";
import {
  runBashCoverageTask as runBashCoverageLanguageTask,
  runBashFormatTask as runBashFormatLanguageTask,
  runBashLintTask as runBashLintLanguageTask,
  runBashUnitTask as runBashUnitLanguageTask,
} from "./languages/bash.js";
import type {
  BashRunnerRuntime,
  DotNetRunnerRuntime,
  GoRunnerRuntime,
  HashicorpRunnerRuntime,
  JvmRunnerRuntime,
  PowerShellRunnerRuntime,
  PythonRunnerRuntime,
  RustRunnerRuntime,
} from "./languages/contracts.js";
import {
  runDotNetCoverageTask as runDotNetCoverageLanguageTask,
  runDotNetFormatTask as runDotNetFormatLanguageTask,
  runDotNetLintTask as runDotNetLintLanguageTask,
  runDotNetMetricsTask as runDotNetMetricsLanguageTask,
  runDotNetTypecheckTask as runDotNetTypecheckLanguageTask,
  runDotNetUnitTask as runDotNetUnitLanguageTask,
} from "./languages/dotnet.js";
import {
  runGoCoverageTask as runGoCoverageLanguageTask,
  runGoFormatTask as runGoFormatLanguageTask,
  runGoLintTask as runGoLintLanguageTask,
  runGoMetricsTask as runGoMetricsLanguageTask,
  runGoTypecheckTask as runGoTypecheckLanguageTask,
  runGoUnitTask as runGoUnitLanguageTask,
} from "./languages/go.js";
import {
  runJavaScriptCoverageTask as runJavaScriptCoverageLanguageTask,
  runJavaScriptE2eTask as runJavaScriptE2eLanguageTask,
  runJavaScriptMetricsTask as runJavaScriptMetricsLanguageTask,
  runJavaScriptUnitTask as runJavaScriptUnitLanguageTask,
} from "./languages/javascript.js";
import {
  isJvmTaskFile as isJvmLanguageTaskFile,
  runJvmCoverageTask as runJvmCoverageLanguageTask,
  runJvmFormatTask as runJvmFormatLanguageTask,
  runJvmLintTask as runJvmLintLanguageTask,
  runJvmMetricsTask as runJvmMetricsLanguageTask,
  runJvmTypecheckTask as runJvmTypecheckLanguageTask,
  runJvmUnitTask as runJvmUnitLanguageTask,
} from "./languages/jvm.js";
import {
  runPowerShellCoverageTask as runPowerShellCoverageLanguageTask,
  runPowerShellFormatTask as runPowerShellFormatLanguageTask,
  runPowerShellLintTask as runPowerShellLintLanguageTask,
  runPowerShellUnitTask as runPowerShellUnitLanguageTask,
} from "./languages/powershell.js";
import type { PythonMetricsProjectMetrics } from "./languages/python-tools.js";
import {
  pythonTaskExtensions as pythonExtensions,
  pythonTaskConfigNames,
  runPythonComplexityTask as runPythonComplexityLanguageTask,
  runPythonCoverageTask as runPythonCoverageLanguageTask,
  runPythonFormatTask as runPythonFormatLanguageTask,
  runPythonLintTask as runPythonLintLanguageTask,
  runPythonMaintainabilityTask as runPythonMaintainabilityLanguageTask,
  runPythonSlocTask as runPythonSlocLanguageTask,
  runPythonTypecheckTask as runPythonTypecheckLanguageTask,
  runPythonUnitTask as runPythonUnitLanguageTask,
  selectPythonProjects as selectGraphPythonProjects,
} from "./languages/python.js";
import {
  runRustCoverageTask as runRustCoverageLanguageTask,
  runRustFormatTask as runRustFormatLanguageTask,
  runRustLintTask as runRustLintLanguageTask,
  runRustMetricsTask as runRustMetricsLanguageTask,
  runRustTypecheckTask as runRustTypecheckLanguageTask,
  runRustUnitTask as runRustUnitLanguageTask,
} from "./languages/rust.js";
import {
  isHclFile,
  isTerraformFile,
  runTerraformFormatTask as runTerraformFormatLanguageTask,
  runTerraformLintTask as runTerraformLintLanguageTask,
  runTerraformTypecheckTask as runTerraformTypecheckLanguageTask,
} from "./languages/terraform.js";
import { runTypeScriptTypecheckTask as runTypeScriptTypecheckLanguageTask } from "./languages/typescript.js";
import * as parsers from "./parsers/index.js";
import { readNestedValue } from "./parsers/utils.js";
import { type Registry, createRegistry } from "./registries.js";
import { AiqEngineCancelledError } from "./run.js";
import { resolveProjectConcurrencyLimit } from "./runtime-tunables.js";
import { ToolRunner } from "./tool-runner.js";
import * as binaries from "./tools/binary-resolver.js";
import * as commands from "./tools/command-builders.js";
import { findNearestAnyConfig, pathExists } from "./utils/path-utils.js";

const biomeExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const sharedBiomeExtensions = new Set([".json", ".jsonc"]);
const javaScriptExtensions = new Set([".cjs", ".js", ".jsx", ".mjs"]);
const typeScriptExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const javaScriptMetricsSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const bashExtensions = new Set([".bash", ".sh"]);
const bashTestExtensions = new Set([".bats"]);
const powerShellExtensions = new Set([".ps1", ".psd1", ".psm1"]);
const dotNetSourceExtensions = new Set([".cs"]);
const dotNetProjectExtensions = new Set([".csproj", ".sln", ".slnx"]);
const htmlExtensions = new Set([".htm", ".html"]);
const cssExtensions = new Set([".css"]);
const yamlExtensions = new Set([".yaml", ".yml"]);
const sqlExtensions = new Set([".sql"]);
const prettierDocumentExtensions = new Set([
  ...htmlExtensions,
  ...cssExtensions,
  ...yamlExtensions,
]);

const dotNetExtensions = new Set([...dotNetSourceExtensions, ...dotNetProjectExtensions]);
const goSourceExtensions = new Set([".go"]);
const rustSourceExtensions = new Set([".rs"]);
const javaSourceExtensions = new Set([".java"]);
const kotlinSourceExtensions = new Set([".kt"]);
const javaScriptProjectConfigNames = ["package.json"];
const goProjectConfigNames = ["go.mod", "go.sum"];
const rustProjectConfigNames = ["Cargo.toml", "Cargo.lock"];
const jvmBuildConfigNames = ["build.gradle.kts", "build.gradle", "pom.xml"];
const jvmSettingsConfigNames = ["settings.gradle.kts", "settings.gradle"];
const jvmTaskConfigNames = [...jvmBuildConfigNames, ...jvmSettingsConfigNames];
const securityExtensions = new Set([
  ".bats",
  ".bash",
  ".cjs",
  ".css",
  ".cs",
  ".csproj",
  ".cts",
  ".go",
  ".hcl",
  ".html",
  ".mod",
  ".js",
  ".json",
  ".jsonc",
  ".java",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".pyi",
  ".rs",
  ".sh",
  ".sql",
  ".sum",
  ".tf",
  ".tfvars",
  ".toml",
  ".gradle",
  ".lock",
  ".sln",
  ".slnx",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);
const sharedSecurityPatterns: Array<{ message: string; pattern: RegExp }> = [
  {
    message: "Potential GitHub token detected.",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  },
  {
    message: "Potential AWS access key detected.",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  },
  {
    message: "Potential npm token detected.",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/u,
  },
  {
    message: "Private key material detected.",
    pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u,
  },
];
type RunnerExecutionContext = {
  cache: CacheService;
  cwd: string;
  graph: ProjectGraph | undefined;
  selectedStages: readonly StageId[];
  stageConfigurations: RunStageConfigurations | undefined;
  signal: AbortSignal | undefined;
  sharedState: RunnerSharedState;
  toolRunner: ToolRunner;
};

type RunnerSharedState = {
  runScopedValues: Map<string, unknown>;
};

type PythonProjectExecution = {
  coverageSummary: Record<string, unknown> | undefined;
  coverageSummaryError: string | undefined;
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
  toolRun: ToolRunResult;
};

const defaultRunnerCache = createCacheService();
const defaultRunnerToolRunner = new ToolRunner(defaultRunnerCache);
const runnerSharedStateByCache = new WeakMap<CacheService, RunnerSharedState>();
export const runnerExecutionContextStorage = new AsyncLocalStorage<RunnerExecutionContext>();

function getRunnerSharedState(cache: CacheService): RunnerSharedState {
  const existing = runnerSharedStateByCache.get(cache);
  if (existing !== undefined) {
    return existing;
  }

  const created: RunnerSharedState = {
    runScopedValues: new Map<string, unknown>(),
  };
  runnerSharedStateByCache.set(cache, created);
  return created;
}

export function resetRunnerRunScopedValues(cache: CacheService): void {
  getRunnerSharedState(cache).runScopedValues.clear();
}

type JvmMetricsFileMetrics = {
  blockCount: number;
  maintainability: {
    rank: string;
    score: number;
  };
  maxComplexity: {
    rank: string;
    score: number;
  };
  raw: {
    sloc: number;
  };
};

type SharedMetricsMode = "sloc" | "complexity" | "maintainability";

type HtmlHintIssue = {
  col: number;
  line: number;
  message: string;
  rule?: {
    id?: string;
  };
  type?: string;
};

type HtmlHintModule = {
  HTMLHint: {
    defaultRuleset: Record<string, unknown>;
    verify: (html: string, ruleset?: Record<string, unknown>) => HtmlHintIssue[];
  };
};

type SqlFormatterModule = {
  format: (sql: string, options?: { language?: parsers.SqlDialect }) => string;
};

type SqlParserModule = {
  Parser: typeof SqlParserClass;
};

const require = createRequire(import.meta.url);
const { Parser: SqlParser } = require("node-sql-parser") as SqlParserModule;
const { HTMLHint } = require("htmlhint") as HtmlHintModule;
const { format: formatSql } = require("sql-formatter") as SqlFormatterModule;

export async function runPlannedTask(
  task: PlannedTask,
  cwdOrContext: EngineContext | string,
  signal?: AbortSignal,
): Promise<StageResult> {
  const runnerContext = createRunnerExecutionContext(cwdOrContext, signal);

  return runnerExecutionContextStorage.run(runnerContext, async () => {
    return runStageDefinitionTask(task, runnerContext.cwd, runnerContext.signal);
  });
}

export function createRunnerExecutionContext(
  cwdOrContext: EngineContext | string,
  signal?: AbortSignal,
): RunnerExecutionContext {
  if (isEngineContext(cwdOrContext)) {
    const toolRunnerOverride = readToolRunnerOverride(cwdOrContext);

    if (toolRunnerOverride !== undefined) {
      return {
        cache: cwdOrContext.cache,
        cwd: cwdOrContext.cwd,
        graph: cwdOrContext.graph,
        selectedStages: [...cwdOrContext.selection.stages],
        stageConfigurations: cwdOrContext.selection.stageConfigurations,
        signal: signal ?? cwdOrContext.signal,
        sharedState: getRunnerSharedState(cwdOrContext.cache),
        toolRunner: toolRunnerOverride,
      };
    }

    return {
      cache: cwdOrContext.cache,
      cwd: cwdOrContext.cwd,
      graph: cwdOrContext.graph,
      selectedStages: [...cwdOrContext.selection.stages],
      stageConfigurations: cwdOrContext.selection.stageConfigurations,
      signal: signal ?? cwdOrContext.signal,
      sharedState: getRunnerSharedState(cwdOrContext.cache),
      toolRunner: new ToolRunner(cwdOrContext.cache),
    };
  }

  return {
    cache: defaultRunnerCache,
    cwd: cwdOrContext,
    graph: undefined,
    selectedStages: [],
    stageConfigurations: undefined,
    signal,
    sharedState: getRunnerSharedState(defaultRunnerCache),
    toolRunner: defaultRunnerToolRunner,
  };
}

function isEngineContext(value: EngineContext | string): value is EngineContext {
  return typeof value !== "string";
}

function readToolRunnerOverride(value: EngineContext): ToolRunner | undefined {
  return "toolRunner" in value && value.toolRunner instanceof ToolRunner
    ? value.toolRunner
    : undefined;
}

function getRunnerExecutionContext(): RunnerExecutionContext {
  return (
    runnerExecutionContextStorage.getStore() ?? {
      cache: defaultRunnerCache,
      cwd: process.cwd(),
      graph: undefined,
      selectedStages: [],
      stageConfigurations: undefined,
      signal: undefined,
      sharedState: getRunnerSharedState(defaultRunnerCache),
      toolRunner: defaultRunnerToolRunner,
    }
  );
}

function getRunnerGraph(): ProjectGraph | undefined {
  return getRunnerExecutionContext().graph;
}

function getRunnerCache(): CacheService {
  return getRunnerExecutionContext().cache;
}

async function getCachedRunnerValue<T>(
  scope: string,
  manifestKey: string,
  cacheKey: string,
  createValue: () => Promise<T>,
): Promise<{ cacheHit: boolean; value: T }> {
  const cache = getRunnerCache();
  const prefix = `${cache.generateKey([scope, manifestKey])}:`;
  const scopedCacheKey = cache.generateKey([scope, cacheKey]);
  await cache.deleteByPrefix(prefix, [scopedCacheKey]);
  return cache.getOrCreate(scopedCacheKey, createValue);
}
function getRunnerSelectedStages(): readonly StageId[] {
  return getRunnerExecutionContext().selectedStages;
}

function getRunnerStageConfigurations(): RunStageConfigurations | undefined {
  return getRunnerExecutionContext().stageConfigurations;
}
function getRunnerRunScopedValue<T>(scope: string, key: string): T | undefined {
  return getRunnerExecutionContext().sharedState.runScopedValues.get(`${scope}:${key}`) as
    | T
    | undefined;
}

function setRunnerRunScopedValue<T>(scope: string, key: string, value: T): void {
  getRunnerExecutionContext().sharedState.runScopedValues.set(`${scope}:${key}`, value);
}

function getRunnerToolRunner(): ToolRunner {
  return getRunnerExecutionContext().toolRunner;
}

export type RunnerStageExecutionContext = {
  cwd: string;
  signal: AbortSignal | undefined;
};

export type RunnerStageHandler = (
  task: PlannedTask,
  context: RunnerStageExecutionContext,
) => Promise<StageResult>;

export type RunnerResolvedStageHandler = {
  files: string[];
  handler: RunnerStageHandler;
};

export type RunnerLanguageModule = {
  id: string;
  stageHandlers: Partial<Record<StageId, RunnerStageHandler>>;
};

export type RunnerStageDefinition = {
  aggregation: "combine" | "not_implemented";
  id: StageId;
  moduleIds: readonly string[];
  note?: string;
  scope: "language-modules" | "stage-only";
};

function hasConfiguredStageSelection(stageId: StageId): boolean {
  return getRunnerStageConfigurations()?.[stageId] !== undefined;
}

function shouldSkipScriptProjectDirectory(directoryPath: string): boolean {
  const name = path.basename(directoryPath).toLowerCase();
  return [
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "obj",
    "target",
    "vendor",
  ].includes(name);
}

function isPythonTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (pythonExtensions.has(extension)) {
    return true;
  }

  return pythonTaskConfigNames.includes(path.basename(file).toLowerCase());
}

function isJavaScriptMetricsTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (javaScriptMetricsSourceExtensions.has(extension)) {
    return true;
  }

  return path.basename(file).toLowerCase() === "package.json";
}

function isGoTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (goSourceExtensions.has(extension)) {
    return true;
  }

  return goProjectConfigNames.includes(path.basename(file).toLowerCase());
}

function isRustTaskFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  if (rustSourceExtensions.has(extension)) {
    return true;
  }

  return rustProjectConfigNames.includes(path.basename(file));
}

function createTypeScriptRunnerRuntime(cwd: string, signal: AbortSignal | undefined) {
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

function createJavaScriptRunnerRuntime(cwd: string, signal: AbortSignal | undefined) {
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

function createPythonRunnerRuntime(
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
    isSharedMetricsCompanionFile: (filePath: string) => {
      const extension = path.extname(filePath).toLowerCase();
      return (
        isJavaScriptMetricsTaskFile(filePath) ||
        dotNetExtensions.has(extension) ||
        isGoTaskFile(filePath) ||
        isJvmLanguageTaskFile(filePath) ||
        isRustTaskFile(filePath)
      );
    },
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

function createHashicorpRunnerRuntime(
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

function createGoRunnerRuntime(cwd: string, signal: AbortSignal | undefined): GoRunnerRuntime {
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
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveInstalledBinary,
    resolveUvxCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

function createBashRunnerRuntime(cwd: string, signal: AbortSignal | undefined): BashRunnerRuntime {
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

function createPowerShellRunnerRuntime(
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

function createRustRunnerRuntime(cwd: string, signal: AbortSignal | undefined): RustRunnerRuntime {
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
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveInstalledBinary,
    resolveUvxCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

function createJvmRunnerRuntime(cwd: string, signal: AbortSignal | undefined): JvmRunnerRuntime {
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

function createDotNetRunnerRuntime(
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
    readFileText: (filePath) => readFile(filePath, "utf8"),
    readProcessFailureMessage,
    readSharedMetricsNote,
    resolveDotNetCommand,
    runExecutable,
    signal,
    throwIfAbortError,
  };
}

export function createRunnerLanguageModuleRegistry(
  modules: readonly RunnerLanguageModule[],
): Registry<RunnerLanguageModule> {
  return createRegistry(modules);
}

export function createRunnerStageDefinitionRegistry(
  stageDefinitions: readonly RunnerStageDefinition[],
): Registry<RunnerStageDefinition> {
  return createRegistry(stageDefinitions);
}

export const defaultRunnerLanguageModules = createRunnerLanguageModuleRegistry([
  {
    id: "terraform",
    stageHandlers: {
      format: (task, context) =>
        runTerraformFormatLanguageTask(
          task,
          createHashicorpRunnerRuntime(context.cwd, context.signal),
        ),
      lint: (task, context) =>
        runTerraformLintLanguageTask(
          task,
          createHashicorpRunnerRuntime(context.cwd, context.signal),
        ),
      typecheck: (task, context) =>
        runTerraformTypecheckLanguageTask(
          task,
          createHashicorpRunnerRuntime(context.cwd, context.signal),
        ),
    },
  },
  {
    id: "biome",
    stageHandlers: {
      format: (task, context) => runBiomeFormatTask(task, context.cwd, context.signal),
      lint: (task, context) => runBiomeLintTask(task, context.cwd, context.signal),
    },
  },
  {
    id: "html",
    stageHandlers: {
      lint: (task, context) => runHtmlLintTask(task, context.cwd),
    },
  },
  {
    id: "css",
    stageHandlers: {
      lint: (task, context) => runCssLintTask(task, context.cwd),
    },
  },
  {
    id: "yaml",
    stageHandlers: {
      lint: (task, context) => runYamlLintTask(task, context.cwd),
    },
  },
  {
    id: "sql",
    stageHandlers: {
      format: (task, context) => runSqlFormatTask(task, context.cwd),
      lint: (task, context) => runSqlLintTask(task, context.cwd),
    },
  },
  {
    id: "documents",
    stageHandlers: {
      format: (task, context) => runPrettierDocumentFormatTask(task, context.cwd),
    },
  },
  {
    id: "bash",
    stageHandlers: {
      coverage: (task, context) =>
        runBashCoverageLanguageTask(task, createBashRunnerRuntime(context.cwd, context.signal)),
      format: (task, context) =>
        runBashFormatLanguageTask(task, createBashRunnerRuntime(context.cwd, context.signal)),
      lint: (task, context) =>
        runBashLintLanguageTask(task, createBashRunnerRuntime(context.cwd, context.signal)),
      unit: (task, context) =>
        runBashUnitLanguageTask(task, createBashRunnerRuntime(context.cwd, context.signal)),
    },
  },
  {
    id: "powershell",
    stageHandlers: {
      coverage: (task, context) =>
        runPowerShellCoverageLanguageTask(
          task,
          createPowerShellRunnerRuntime(context.cwd, context.signal),
        ),
      format: (task, context) =>
        runPowerShellFormatLanguageTask(
          task,
          createPowerShellRunnerRuntime(context.cwd, context.signal),
        ),
      lint: (task, context) =>
        runPowerShellLintLanguageTask(
          task,
          createPowerShellRunnerRuntime(context.cwd, context.signal),
        ),
      unit: (task, context) =>
        runPowerShellUnitLanguageTask(
          task,
          createPowerShellRunnerRuntime(context.cwd, context.signal),
        ),
    },
  },
  {
    id: "go",
    stageHandlers: {
      complexity: (task, context) =>
        runGoMetricsLanguageTask(
          task,
          createGoRunnerRuntime(context.cwd, context.signal),
          "complexity",
        ),
      coverage: (task, context) =>
        runGoCoverageLanguageTask(task, createGoRunnerRuntime(context.cwd, context.signal)),
      format: (task, context) =>
        runGoFormatLanguageTask(task, createGoRunnerRuntime(context.cwd, context.signal)),
      lint: (task, context) =>
        runGoLintLanguageTask(task, createGoRunnerRuntime(context.cwd, context.signal)),
      maintainability: (task, context) =>
        runGoMetricsLanguageTask(
          task,
          createGoRunnerRuntime(context.cwd, context.signal),
          "maintainability",
        ),
      sloc: (task, context) =>
        runGoMetricsLanguageTask(task, createGoRunnerRuntime(context.cwd, context.signal), "sloc"),
      typecheck: (task, context) =>
        runGoTypecheckLanguageTask(task, createGoRunnerRuntime(context.cwd, context.signal)),
      unit: (task, context) =>
        runGoUnitLanguageTask(task, createGoRunnerRuntime(context.cwd, context.signal)),
    },
  },
  {
    id: "rust",
    stageHandlers: {
      complexity: (task, context) =>
        runRustMetricsLanguageTask(
          task,
          createRustRunnerRuntime(context.cwd, context.signal),
          "complexity",
        ),
      coverage: (task, context) =>
        runRustCoverageLanguageTask(task, createRustRunnerRuntime(context.cwd, context.signal)),
      format: (task, context) =>
        runRustFormatLanguageTask(task, createRustRunnerRuntime(context.cwd, context.signal)),
      lint: (task, context) =>
        runRustLintLanguageTask(task, createRustRunnerRuntime(context.cwd, context.signal)),
      maintainability: (task, context) =>
        runRustMetricsLanguageTask(
          task,
          createRustRunnerRuntime(context.cwd, context.signal),
          "maintainability",
        ),
      sloc: (task, context) =>
        runRustMetricsLanguageTask(
          task,
          createRustRunnerRuntime(context.cwd, context.signal),
          "sloc",
        ),
      typecheck: (task, context) =>
        runRustTypecheckLanguageTask(task, createRustRunnerRuntime(context.cwd, context.signal)),
      unit: (task, context) =>
        runRustUnitLanguageTask(task, createRustRunnerRuntime(context.cwd, context.signal)),
    },
  },
  {
    id: "jvm",
    stageHandlers: {
      complexity: (task, context) =>
        runJvmMetricsLanguageTask(
          task,
          createJvmRunnerRuntime(context.cwd, context.signal),
          "complexity",
        ),
      coverage: (task, context) =>
        runJvmCoverageLanguageTask(task, createJvmRunnerRuntime(context.cwd, context.signal)),
      format: (task, context) =>
        runJvmFormatLanguageTask(task, createJvmRunnerRuntime(context.cwd, context.signal)),
      lint: (task, context) =>
        runJvmLintLanguageTask(task, createJvmRunnerRuntime(context.cwd, context.signal)),
      maintainability: (task, context) =>
        runJvmMetricsLanguageTask(
          task,
          createJvmRunnerRuntime(context.cwd, context.signal),
          "maintainability",
        ),
      sloc: (task, context) =>
        runJvmMetricsLanguageTask(
          task,
          createJvmRunnerRuntime(context.cwd, context.signal),
          "sloc",
        ),
      typecheck: (task, context) =>
        runJvmTypecheckLanguageTask(task, createJvmRunnerRuntime(context.cwd, context.signal)),
      unit: (task, context) =>
        runJvmUnitLanguageTask(task, createJvmRunnerRuntime(context.cwd, context.signal)),
    },
  },
  {
    id: "dotnet",
    stageHandlers: {
      complexity: (task, context) =>
        runDotNetMetricsLanguageTask(
          task,
          createDotNetRunnerRuntime(context.cwd, context.signal),
          "complexity",
        ),
      coverage: (task, context) =>
        runDotNetCoverageLanguageTask(task, createDotNetRunnerRuntime(context.cwd, context.signal)),
      format: (task, context) =>
        runDotNetFormatLanguageTask(task, createDotNetRunnerRuntime(context.cwd, context.signal)),
      lint: (task, context) =>
        runDotNetLintLanguageTask(task, createDotNetRunnerRuntime(context.cwd, context.signal)),
      maintainability: (task, context) =>
        runDotNetMetricsLanguageTask(
          task,
          createDotNetRunnerRuntime(context.cwd, context.signal),
          "maintainability",
        ),
      sloc: (task, context) =>
        runDotNetMetricsLanguageTask(
          task,
          createDotNetRunnerRuntime(context.cwd, context.signal),
          "sloc",
        ),
      typecheck: (task, context) =>
        runDotNetTypecheckLanguageTask(
          task,
          createDotNetRunnerRuntime(context.cwd, context.signal),
        ),
      unit: (task, context) =>
        runDotNetUnitLanguageTask(task, createDotNetRunnerRuntime(context.cwd, context.signal)),
    },
  },
  {
    id: "typescript",
    stageHandlers: {
      typecheck: (task, context) =>
        runTypeScriptTypecheckLanguageTask(
          task,
          createTypeScriptRunnerRuntime(context.cwd, context.signal),
        ),
    },
  },
  {
    id: "javascript",
    stageHandlers: {
      complexity: (task, context) =>
        runJavaScriptMetricsLanguageTask(
          task,
          createJavaScriptRunnerRuntime(context.cwd, context.signal),
          "complexity",
        ),
      coverage: (task, context) =>
        runJavaScriptCoverageLanguageTask(
          task,
          createJavaScriptRunnerRuntime(context.cwd, context.signal),
        ),
      e2e: (task, context) =>
        runJavaScriptE2eLanguageTask(
          task,
          createJavaScriptRunnerRuntime(context.cwd, context.signal),
        ),
      maintainability: (task, context) =>
        runJavaScriptMetricsLanguageTask(
          task,
          createJavaScriptRunnerRuntime(context.cwd, context.signal),
          "maintainability",
        ),
      sloc: (task, context) =>
        runJavaScriptMetricsLanguageTask(
          task,
          createJavaScriptRunnerRuntime(context.cwd, context.signal),
          "sloc",
        ),
      unit: (task, context) =>
        runJavaScriptUnitLanguageTask(
          task,
          createJavaScriptRunnerRuntime(context.cwd, context.signal),
        ),
    },
  },
  {
    id: "python",
    stageHandlers: {
      complexity: (task, context) =>
        runPythonComplexityLanguageTask(
          task,
          createPythonRunnerRuntime(context.cwd, context.signal),
        ),
      coverage: (task, context) =>
        runPythonCoverageLanguageTask(task, createPythonRunnerRuntime(context.cwd, context.signal)),
      format: (task, context) =>
        runPythonFormatLanguageTask(task, createPythonRunnerRuntime(context.cwd, context.signal)),
      lint: (task, context) =>
        runPythonLintLanguageTask(task, createPythonRunnerRuntime(context.cwd, context.signal)),
      maintainability: (task, context) =>
        runPythonMaintainabilityLanguageTask(
          task,
          createPythonRunnerRuntime(context.cwd, context.signal),
        ),
      sloc: (task, context) =>
        runPythonSlocLanguageTask(task, createPythonRunnerRuntime(context.cwd, context.signal)),
      typecheck: (task, context) =>
        runPythonTypecheckLanguageTask(
          task,
          createPythonRunnerRuntime(context.cwd, context.signal),
        ),
      unit: (task, context) =>
        runPythonUnitLanguageTask(task, createPythonRunnerRuntime(context.cwd, context.signal)),
    },
  },
  {
    id: "security",
    stageHandlers: {
      security: (task) => runSharedSecurityTask(task),
    },
  },
]);

export const defaultStageDefinitions = createRunnerStageDefinitionRegistry([
  createCombinedStageDefinition("lint", [
    "terraform",
    "biome",
    "html",
    "css",
    "yaml",
    "sql",
    "bash",
    "powershell",
    "go",
    "rust",
    "jvm",
    "dotnet",
    "python",
  ]),
  createCombinedStageDefinition("format", [
    "terraform",
    "biome",
    "documents",
    "sql",
    "bash",
    "powershell",
    "go",
    "rust",
    "jvm",
    "dotnet",
    "python",
  ]),
  createCombinedStageDefinition("typecheck", [
    "terraform",
    "go",
    "rust",
    "dotnet",
    "jvm",
    "typescript",
    "python",
  ]),
  createCombinedStageDefinition("unit", [
    "bash",
    "powershell",
    "go",
    "rust",
    "dotnet",
    "jvm",
    "javascript",
    "python",
  ]),
  createCombinedStageDefinition("e2e", ["javascript"]),
  createCombinedStageDefinition("sloc", ["javascript", "go", "rust", "dotnet", "jvm", "python"]),
  createCombinedStageDefinition("complexity", [
    "javascript",
    "go",
    "rust",
    "dotnet",
    "jvm",
    "python",
  ]),
  createCombinedStageDefinition("maintainability", [
    "javascript",
    "go",
    "rust",
    "dotnet",
    "jvm",
    "python",
  ]),
  createCombinedStageDefinition("coverage", [
    "bash",
    "powershell",
    "go",
    "rust",
    "dotnet",
    "jvm",
    "javascript",
    "python",
  ]),
  createCombinedStageDefinition("security", ["security"]),
]);

async function runStageDefinitionTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  const stageDefinition = defaultStageDefinitions.byId.get(task.stageId);
  if (stageDefinition === undefined) {
    return createNotImplementedStageResult(task.stageId);
  }

  if (stageDefinition.aggregation === "not_implemented") {
    return createNotImplementedStageResult(task.stageId, stageDefinition.note);
  }

  const handlers = resolveStageHandlers(stageDefinition, task);
  if (handlers.length === 0) {
    if (hasConfiguredStageSelection(task.stageId)) {
      return combineStageResults(task.stageId, []);
    }

    return createNotImplementedStageResult(task.stageId, stageDefinition.note);
  }

  return combineStageResults(
    task.stageId,
    await Promise.all(
      handlers.map(({ files, handler }) => handler({ ...task, files }, { cwd, signal })),
    ),
  );
}

export function resolveStageHandlers(
  stageDefinition: RunnerStageDefinition,
  task: PlannedTask,
): RunnerResolvedStageHandler[] {
  return resolveStageHandlersFromModules(stageDefinition, task, defaultRunnerLanguageModules);
}

export function resolveStageHandlersFromModules(
  stageDefinition: RunnerStageDefinition,
  task: PlannedTask,
  languageModules: Registry<RunnerLanguageModule>,
): RunnerResolvedStageHandler[] {
  const configuredStage = getRunnerStageConfigurations()?.[stageDefinition.id];

  if (configuredStage === undefined) {
    return stageDefinition.moduleIds.flatMap((moduleId) => {
      const languageModule = languageModules.byId.get(moduleId);
      if (languageModule === undefined) {
        throw new Error(
          `Stage definition '${stageDefinition.id}' references unknown language module '${moduleId}'.`,
        );
      }

      const handler = languageModule.stageHandlers[stageDefinition.id];
      return handler === undefined ? [] : [{ files: [...task.files], handler }];
    });
  }

  return groupConfiguredStageLanguages(configuredStage).flatMap(({ languageIds, toolId }) => {
    const languageModule = languageModules.byId.get(toolId);
    if (languageModule === undefined) {
      throw new Error(
        `Stage selection '${stageDefinition.id}' references unknown tool '${toolId}'.`,
      );
    }

    const handler = languageModule.stageHandlers[stageDefinition.id];
    if (handler === undefined) {
      return [];
    }

    return [
      {
        files: filterFilesForConfiguredToolLanguages(task.files, languageIds, toolId),
        handler,
      },
    ];
  });
}

export function createCombinedStageDefinition(
  id: StageId,
  moduleIds: readonly string[],
): RunnerStageDefinition {
  return {
    aggregation: moduleIds.length === 0 ? "not_implemented" : "combine",
    id,
    moduleIds,
    scope: moduleIds.length === 0 ? "stage-only" : "language-modules",
  };
}

function groupConfiguredStageLanguages(stageConfiguration: RunStageConfiguration): Array<{
  languageIds: LanguageId[];
  toolId: string;
}> {
  const languageIdsByTool = new Map<string, LanguageId[]>();

  for (const [languageId, languageConfiguration] of Object.entries(stageConfiguration.languages)) {
    const toolLanguages = languageIdsByTool.get(languageConfiguration.toolId);
    if (toolLanguages === undefined) {
      languageIdsByTool.set(languageConfiguration.toolId, [languageId as LanguageId]);
      continue;
    }

    toolLanguages.push(languageId as LanguageId);
  }

  return [...languageIdsByTool.entries()].map(([toolId, languageIds]) => ({ languageIds, toolId }));
}

function filterFilesForConfiguredLanguages(
  files: readonly string[],
  languageIds: readonly LanguageId[],
): string[] {
  if (languageIds.length === 0) {
    return [];
  }

  return files.filter((file) =>
    languageIds.some((languageId) => fileMatchesLanguage(file, languageId)),
  );
}

function filterFilesForConfiguredToolLanguages(
  files: readonly string[],
  languageIds: readonly LanguageId[],
  toolId: string,
): string[] {
  if (
    toolId === "biome" &&
    (languageIds.includes("javascript") || languageIds.includes("typescript"))
  ) {
    return files.filter((file) => {
      const extension = path.extname(path.resolve(file)).toLowerCase();
      return (
        sharedBiomeExtensions.has(extension) ||
        languageIds.some((languageId) => fileMatchesConfiguredBiomeLanguage(file, languageId))
      );
    });
  }

  return filterFilesForConfiguredLanguages(files, languageIds);
}

function fileMatchesConfiguredBiomeLanguage(file: string, languageId: LanguageId): boolean {
  const normalizedPath = path.resolve(file);
  const extension = path.extname(normalizedPath).toLowerCase();
  const lowerBaseName = path.basename(normalizedPath).toLowerCase();

  switch (languageId) {
    case "javascript":
      return (
        javaScriptExtensions.has(extension) || javaScriptProjectConfigNames.includes(lowerBaseName)
      );
    case "typescript":
      return typeScriptExtensions.has(extension) || lowerBaseName === "tsconfig.json";
    default:
      return fileMatchesLanguage(file, languageId);
  }
}

function fileMatchesLanguage(file: string, languageId: LanguageId): boolean {
  const normalizedPath = path.resolve(file);
  const extension = path.extname(normalizedPath).toLowerCase();
  const baseName = path.basename(normalizedPath);
  const lowerBaseName = baseName.toLowerCase();

  switch (languageId) {
    case "javascript":
      return (
        javaScriptExtensions.has(extension) || javaScriptProjectConfigNames.includes(lowerBaseName)
      );
    case "typescript":
      return (
        typeScriptExtensions.has(extension) ||
        lowerBaseName === "tsconfig.json" ||
        javaScriptProjectConfigNames.includes(lowerBaseName)
      );
    case "python":
      return isPythonTaskFile(file);
    case "terraform":
      return isTerraformFile(file);
    case "hcl":
      return isHclFile(file);
    case "go":
      return goSourceExtensions.has(extension) || goProjectConfigNames.includes(lowerBaseName);
    case "rust":
      return rustSourceExtensions.has(extension) || rustProjectConfigNames.includes(baseName);
    case "dotnet":
      return dotNetExtensions.has(extension);
    case "java":
      return javaSourceExtensions.has(extension) || jvmTaskConfigNames.includes(lowerBaseName);
    case "kotlin":
      return kotlinSourceExtensions.has(extension) || jvmTaskConfigNames.includes(lowerBaseName);
    case "bash":
      return bashExtensions.has(extension) || bashTestExtensions.has(extension);
    case "powershell":
      return powerShellExtensions.has(extension);
    case "html":
      return htmlExtensions.has(extension);
    case "css":
      return cssExtensions.has(extension);
    case "yaml":
      return yamlExtensions.has(extension);
    case "sql":
      return sqlExtensions.has(extension);
    case "documents":
      return prettierDocumentExtensions.has(extension);
  }
}

export function createNotImplementedStageResult(stageId: StageId, note?: string): StageResult {
  return {
    diagnostics: [],
    durationMs: 0,
    notes: [
      note ??
        `Stage '${stageId}' is planned but no tool runner is implemented in the rewrite foundation slice yet.`,
    ],
    stageId,
    status: "not_implemented",
    toolRuns: [],
  };
}

async function runBiomeLintTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  const files = filterFiles(task.files, biomeExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No Biome-supported files were selected for lint.");
  }

  const args = commands.createBiomeLintArgs({ files });

  try {
    const outcome = await runNodeTool(
      resolvePackageBinaryPath("@biomejs/biome/package.json", "bin/biome"),
      args,
      cwd,
      signal,
    );
    const diagnostics = parsers.parseBiomeDiagnostics(outcome.stdout, cwd);
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        createProcessFailureDiagnostic(
          files[0] ?? cwd,
          "biome",
          readProcessFailureMessage("Biome", outcome.stderr, outcome.stdout, outcome.exitCode),
        ),
      );
    }

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      notes:
        status === "passed"
          ? ["Biome lint passed."]
          : [
              `Biome reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status,
      toolRuns: [
        createToolRunResult(
          "biome",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      ],
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(task.stageId, "biome", files[0] ?? cwd, error);
  }
}

async function runBiomeFormatTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  const files = filterFiles(task.files, biomeExtensions);
  if (files.length === 0) {
    return createNoopStageResult(
      task.stageId,
      "No Biome-supported files were selected for format.",
    );
  }

  const args = commands.createBiomeFormatArgs({ files });

  try {
    const outcome = await runNodeTool(
      resolvePackageBinaryPath("@biomejs/biome/package.json", "bin/biome"),
      args,
      cwd,
      signal,
    );
    const diagnostics = parsers.parseBiomeDiagnostics(outcome.stdout, cwd);
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        createProcessFailureDiagnostic(
          files[0] ?? cwd,
          "biome",
          readProcessFailureMessage(
            "Biome format",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      notes:
        status === "passed"
          ? ["Biome format passed."]
          : [
              `Biome reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status,
      toolRuns: [
        createToolRunResult(
          "biome",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      ],
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(task.stageId, "biome", files[0] ?? cwd, error);
  }
}

async function runHtmlLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, htmlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No HTML files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              return HTMLHint.verify(source, HTMLHint.defaultRuleset).map((issue) =>
                parsers.createHtmlHintDiagnostic(file, issue),
              );
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["HTMLHint passed."]
          : [
              `HTMLHint reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "htmlhint",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "htmlhint", files[0] ?? cwd, error);
  }
}

async function runCssLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, cssExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No CSS files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const missingConfigFiles: string[] = [];
      const rawDiagnostics = (
        await Promise.all(
          files.map(async (file) => {
            const source = await readFile(file, "utf8");
            let resolvedConfig: Awaited<ReturnType<typeof stylelint.resolveConfig>>;

            try {
              resolvedConfig = await stylelint.resolveConfig(file, { cwd });
            } catch (error) {
              if (isMissingStylelintConfigError(error)) {
                missingConfigFiles.push(file);
                return [];
              }

              throw error;
            }

            if (resolvedConfig === null || resolvedConfig === undefined) {
              missingConfigFiles.push(file);
              return [];
            }

            const result = await stylelint.lint({
              code: source,
              codeFilename: file,
              config: resolvedConfig,
              cwd,
              formatter: "json",
            });
            return parseStylelintDiagnostics(result.report, cwd);
          }),
        )
      ).flat();
      const diagnostics = normalizeDiagnosticsToSelection(
        deduplicateDiagnostics(rawDiagnostics),
        files,
      );
      const status: StageResult["status"] =
        diagnostics.length > 0
          ? "failed"
          : missingConfigFiles.length > 0
            ? "not_implemented"
            : "passed";
      return {
        diagnostics,
        missingConfigFiles,
        status,
      };
    });

    const notes =
      timed.result.status === "passed"
        ? ["Stylelint passed."]
        : timed.result.status === "failed"
          ? [
              `Stylelint reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
              ...(timed.result.missingConfigFiles.length === 0
                ? []
                : [
                    createMissingStylelintConfigNote(task.stageId, timed.result.missingConfigFiles),
                  ]),
            ]
          : [createMissingStylelintConfigNote(task.stageId, timed.result.missingConfigFiles)];

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes,
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "stylelint",
          files,
          timed.durationMs,
          timed.result.status === "not_implemented"
            ? undefined
            : timed.result.status === "passed"
              ? 0
              : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "stylelint", files[0] ?? cwd, error);
  }
}

async function runYamlLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, yamlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No YAML files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              return parseAllDocuments(source).flatMap((document) => [
                ...document.errors.map((error) =>
                  parsers.createYamlDiagnostic(file, error.message, error.linePos, "error"),
                ),
                ...document.warnings.map((warning) =>
                  parsers.createYamlDiagnostic(file, warning.message, warning.linePos, "warning"),
                ),
              ]);
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["YAML parse checks passed."]
          : [
              `YAML parse checks reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "yaml",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "yaml", files[0] ?? cwd, error);
  }
}

async function runSqlLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, sqlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No SQL files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const parser = new SqlParser();
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              const dialectResult = parsers.resolveSqlDialect(
                parser,
                source,
                "node-sql-parser",
                file,
              );
              return "diagnostic" in dialectResult ? [dialectResult.diagnostic] : [];
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["SQL parse checks passed."]
          : [
              `SQL parse checks reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "node-sql-parser",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "node-sql-parser", files[0] ?? cwd, error);
  }
}

async function runPrettierDocumentFormatTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, prettierDocumentExtensions);
  if (files.length === 0) {
    return createNoopStageResult(
      task.stageId,
      "No HTML, CSS, or YAML files were selected for format.",
    );
  }

  try {
    const timed = await measureOperation(async () => {
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              const resolvedConfig = (await prettier.resolveConfig(file)) ?? {};

              try {
                const isFormatted = await prettier.check(source, {
                  ...resolvedConfig,
                  filepath: file,
                });
                return isFormatted ? [] : [createFormattingDiagnostic(file, "prettier")];
              } catch (error) {
                return [createPrettierDiagnostic(file, error)];
              }
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["Prettier document format checks passed."]
          : [
              `Prettier reported ${timed.result.diagnostics.length} formatting diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "prettier",
          ["--check", ...files],
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "prettier", files[0] ?? cwd, error);
  }
}

async function runSqlFormatTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, sqlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No SQL files were selected for format.");
  }

  try {
    const timed = await measureOperation(async () => {
      const parser = new SqlParser();
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              const dialectResult = parsers.resolveSqlDialect(
                parser,
                source,
                "sql-formatter",
                file,
              );
              if ("diagnostic" in dialectResult) {
                return [dialectResult.diagnostic];
              }

              const formatted = ensureTrailingNewline(
                formatSql(source, { language: dialectResult.dialect }),
              );
              return normalizeLineEndings(source) === normalizeLineEndings(formatted)
                ? []
                : [createFormattingDiagnostic(file, "sql-formatter")];
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["SQL formatter checks passed."]
          : [
              `SQL formatter reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "sql-formatter",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "sql-formatter", files[0] ?? cwd, error);
  }
}

async function runSharedSecurityTask(task: PlannedTask): Promise<StageResult> {
  const files = filterFiles(task.files, securityExtensions);
  if (files.length === 0) {
    return createNoopStageResult(
      task.stageId,
      "No JavaScript, TypeScript, JSON, Bash, PowerShell, Python, HTML, CSS, YAML, SQL, Terraform, HCL, .NET, Go, Rust, or JVM files were selected for security scanning.",
    );
  }

  const startedAt = new Date();
  const diagnostics: Diagnostic[] = [];
  let currentFile = files[0] ?? task.files[0] ?? process.cwd();

  try {
    for (const file of files) {
      currentFile = file;
      const source = await readFile(file, "utf8");
      for (const rule of sharedSecurityPatterns) {
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(source)) {
          continue;
        }

        diagnostics.push({
          file,
          message: rule.message,
          severity: "error",
          source: "aiq-security",
        });
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(
      task.stageId,
      "aiq-security",
      currentFile,
      error,
      Date.now() - startedAt.getTime(),
      diagnostics,
    );
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs,
    notes:
      status === "passed"
        ? ["Shared security scan passed."]
        : [
            `Shared security scan reported ${diagnostics.length} finding${diagnostics.length === 1 ? "" : "s"}.`,
          ],
    stageId: task.stageId,
    status,
    toolRuns: [
      createToolRunResult(
        "aiq-security",
        ["scan", ...files],
        durationMs,
        status === "passed" ? 0 : 1,
        status,
        finishedAt.toISOString(),
        startedAt.toISOString(),
      ),
    ],
  };
}

function normalizeDiagnosticsToSelection(
  diagnostics: readonly Diagnostic[],
  selectedFiles: readonly string[],
): Diagnostic[] {
  if (diagnostics.length === 0 || selectedFiles.length === 0) {
    return [...diagnostics];
  }

  const selectedPaths = selectedFiles.map((file) => ({
    file,
    normalized: path.normalize(file),
    realPath: tryRealpath(file),
  }));

  return diagnostics.map((diagnostic) => {
    const matchedFile = matchDiagnosticFile(diagnostic.file, selectedPaths);
    if (matchedFile === undefined || matchedFile === diagnostic.file) {
      return diagnostic;
    }

    return {
      ...diagnostic,
      file: matchedFile,
    };
  });
}

function matchDiagnosticFile(
  file: string,
  selectedPaths: ReadonlyArray<{ file: string; normalized: string; realPath: string | undefined }>,
): string | undefined {
  const normalized = path.normalize(file);
  const directMatch = selectedPaths.find((entry) => entry.normalized === normalized);
  if (directMatch !== undefined) {
    return directMatch.file;
  }

  const realPath = tryRealpath(file);
  if (realPath === undefined) {
    return undefined;
  }

  return selectedPaths.find((entry) => entry.realPath === realPath)?.file;
}

function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const uniqueDiagnostics: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.source,
      diagnostic.code ?? "",
      diagnostic.file,
      diagnostic.range?.startLine ?? "",
      diagnostic.range?.startColumn ?? "",
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueDiagnostics.push(diagnostic);
  }

  return uniqueDiagnostics;
}

function createMissingStylelintConfigNote(stageId: StageId, files: readonly string[]): string {
  if (files.length === 0) {
    return `No Stylelint configuration was detected for ${stageId}.`;
  }

  return `No Stylelint configuration was detected for ${stageId} in: ${files.join(", ")}.`;
}

function isMissingStylelintConfigError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "ConfigurationError" &&
    error.message.startsWith("No configuration provided")
  );
}

async function findFirstFile(
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

async function findMatchingFiles(
  directory: string,
  predicate: (filePath: string) => boolean,
  shouldSkipDirectory?: (directoryPath: string) => boolean,
): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const matches: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory?.(entryPath) === true) {
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

async function runPythonLintTask(task: PlannedTask, signal?: AbortSignal): Promise<StageResult> {
  const files = filterFiles(task.files, pythonExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No Python files were selected for lint.");
  }

  const diagnostics: Diagnostic[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;

  try {
    const projectResults = await runProjectBatches(
      await resolvePythonProjects(files),
      async (project) => {
        const args = commands.createRuffCheckArgs({ files: project.files });
        const outcome = await runExecutable(
          binaries.resolvePythonCommand(),
          args,
          project.projectRoot,
          signal,
        );
        const parsedDiagnostics = parsers.parseRuffDiagnostics(outcome.stdout, project.projectRoot);

        if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
          parsedDiagnostics.push(
            createProcessFailureDiagnostic(
              project.files[0] ?? project.projectRoot,
              "ruff",
              readProcessFailureMessage("Ruff", outcome.stderr, outcome.stdout, outcome.exitCode),
            ),
          );
        }

        return {
          diagnostics: parsedDiagnostics,
          durationMs: outcome.durationMs,
          toolRun: createToolRunResult(
            "ruff",
            args,
            outcome.durationMs,
            outcome.exitCode,
            outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
            outcome.finishedAt,
            outcome.startedAt,
          ),
        };
      },
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(
      task.stageId,
      "ruff",
      files[0] ?? process.cwd(),
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? ["Ruff lint passed."]
        : [`Ruff reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

async function runPythonFormatTask(task: PlannedTask, signal?: AbortSignal): Promise<StageResult> {
  const files = filterFiles(task.files, pythonExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No Python files were selected for format.");
  }

  const diagnostics: Diagnostic[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;

  try {
    const projectResults = await runProjectBatches(
      await resolvePythonProjects(files),
      async (project) => {
        const args = commands.createRuffFormatArgs({ files: project.files });
        const outcome = await runExecutable(
          binaries.resolvePythonCommand(),
          args,
          project.projectRoot,
          signal,
        );
        const parsedDiagnostics = parsers.parseRuffFormatDiagnostics(
          outcome.stdout,
          project.projectRoot,
        );

        if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
          parsedDiagnostics.push(
            createProcessFailureDiagnostic(
              project.files[0] ?? project.projectRoot,
              "ruff",
              readProcessFailureMessage(
                "Ruff format",
                outcome.stderr,
                outcome.stdout,
                outcome.exitCode,
              ),
            ),
          );
        }

        return {
          diagnostics: parsedDiagnostics,
          durationMs: outcome.durationMs,
          toolRun: createToolRunResult(
            "ruff",
            args,
            outcome.durationMs,
            outcome.exitCode,
            outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
            outcome.finishedAt,
            outcome.startedAt,
          ),
        };
      },
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(
      task.stageId,
      "ruff",
      files[0] ?? process.cwd(),
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes:
      status === "passed"
        ? ["Ruff format passed."]
        : [
            `Ruff reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`,
          ],
    stageId: task.stageId,
    status,
    toolRuns,
  };
}

async function runPythonUnitTask(task: PlannedTask, signal?: AbortSignal): Promise<StageResult> {
  return runPythonTestStage(task, signal, "unit");
}

async function runPythonCoverageTask(
  task: PlannedTask,
  signal?: AbortSignal,
): Promise<StageResult> {
  return runPythonTestStage(task, signal, "coverage");
}

async function runPythonTestStage(
  task: PlannedTask,
  signal: AbortSignal | undefined,
  mode: "coverage" | "unit",
): Promise<StageResult> {
  const files = filterFiles(task.files, pythonExtensions);
  if (files.length === 0) {
    return createNoopStageResult(
      task.stageId,
      `No Python files were selected for ${task.stageId}.`,
    );
  }

  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;

  try {
    const projectResults = await runProjectBatches(
      await resolvePythonProjects(files),
      async (project) => runPythonProjectTestTask(project, mode, signal),
    );

    for (const projectResult of projectResults) {
      totalDurationMs += projectResult.durationMs;
      diagnostics.push(...projectResult.diagnostics);
      notes.push(projectResult.note);
      toolRuns.push(projectResult.toolRun);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(
      task.stageId,
      mode === "coverage" ? "pytest-cov" : "pytest",
      files[0] ?? process.cwd(),
      error,
      totalDurationMs,
      diagnostics,
      toolRuns,
    );
  }

  return {
    diagnostics,
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status: diagnostics.length === 0 ? "passed" : "failed",
    toolRuns,
  };
}

async function runPythonProjectTestTask(
  project: { files: string[]; projectRoot: string },
  mode: "coverage" | "unit",
  signal?: AbortSignal,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const allowCoverageReuse =
    getRunnerSelectedStages().includes("unit") && getRunnerSelectedStages().includes("coverage");
  const cacheKey = createPythonProjectExecutionKey(project);
  const cachedExecution = allowCoverageReuse
    ? getRunnerRunScopedValue<PythonProjectExecution>("python:test-execution", cacheKey)
    : undefined;
  if (allowCoverageReuse && cachedExecution !== undefined) {
    return materializePythonProjectStageResult(cachedExecution, mode, true);
  }

  const preferCoverageExecution = allowCoverageReuse && mode === "unit";
  const preferredMode = preferCoverageExecution ? "coverage" : mode;
  const execution = await executePythonProjectTestTask(project, preferredMode, signal);

  if (
    allowCoverageReuse &&
    execution.coverageSummaryError === undefined &&
    !isPythonCoverageOnlyFailure(execution) &&
    preferredMode === "coverage"
  ) {
    setRunnerRunScopedValue("python:test-execution", cacheKey, execution);
  }

  if (shouldFallbackToPlainPythonUnit(preferCoverageExecution, execution)) {
    return materializePythonProjectStageResult(
      await executePythonProjectTestTask(project, "unit", signal),
      "unit",
      false,
    );
  }

  return materializePythonProjectStageResult(execution, mode, false);
}

async function executePythonProjectTestTask(
  project: { files: string[]; projectRoot: string },
  mode: "coverage" | "unit",
  signal?: AbortSignal,
): Promise<PythonProjectExecution> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-python-runner-"));

  try {
    const junitPath = path.join(tempDir, "junit.xml");
    const coveragePath = path.join(tempDir, "coverage.json");
    const args = commands.createPythonTestArgs({ coveragePath, junitPath, mode });
    const outcome = await runExecutable(
      binaries.resolvePythonCommand(),
      args,
      project.projectRoot,
      signal,
      {
        PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
        ...(mode === "coverage"
          ? {
              COVERAGE_FILE: path.join(tempDir, ".coverage"),
            }
          : {}),
      },
    );
    const reportXml = await readOptionalTextFile(junitPath);
    const report = parsers.parsePytestReport(reportXml, project.projectRoot);
    const coverageSummary = mode === "coverage" ? await readJsonFile(coveragePath) : undefined;
    const status =
      (outcome.exitCode === 0 || outcome.exitCode === 5) && report.diagnostics.length === 0
        ? "passed"
        : "failed";

    if (status === "failed" && report.diagnostics.length === 0) {
      report.diagnostics.push(
        createProcessFailureDiagnostic(
          project.files[0] ?? project.projectRoot,
          mode === "coverage" ? "pytest-cov" : "pytest",
          readProcessFailureMessage("pytest", outcome.stderr, outcome.stdout, outcome.exitCode),
        ),
      );
    }

    return {
      coverageSummary,
      coverageSummaryError:
        mode === "coverage" &&
        outcome.exitCode === 0 &&
        readCoverageMetric(coverageSummary, "totals", "percent_covered") === undefined
          ? `Expected coverage summary at "${coveragePath}" for pytest coverage with total line coverage.`
          : undefined,
      diagnostics: report.diagnostics,
      toolRun: createToolRunResult(
        mode === "coverage" ? "pytest-cov" : "pytest",
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
      summary: report.summary,
    };
  } finally {
    try {
      await rm(tempDir, { force: true, recursive: true });
    } catch (error) {
      void error;
    }
  }
}

function materializePythonProjectStageResult(
  execution: PythonProjectExecution,
  mode: "coverage" | "unit",
  cacheHit: boolean,
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
} {
  if (mode === "coverage" && execution.coverageSummaryError !== undefined) {
    throw new Error(execution.coverageSummaryError);
  }

  return {
    diagnostics: [...execution.diagnostics],
    durationMs: cacheHit ? 0 : execution.toolRun.durationMs,
    note:
      mode === "coverage"
        ? readPythonCoverageNote(execution.coverageSummary, execution.summary)
        : readPythonUnitNote(execution.summary),
    toolRun: parsers.cloneToolRunResult(execution.toolRun, cacheHit),
  };
}

function shouldFallbackToPlainPythonUnit(
  preferCoverageExecution: boolean,
  execution: PythonProjectExecution,
): boolean {
  return (
    preferCoverageExecution &&
    (execution.coverageSummaryError !== undefined || isPythonCoverageOnlyFailure(execution))
  );
}

function isPythonCoverageOnlyFailure(execution: PythonProjectExecution): boolean {
  return execution.toolRun.status === "failed" && execution.summary.failed === 0;
}

function createPythonProjectExecutionKey(project: {
  files: string[];
  projectRoot: string;
}): string {
  return `${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

async function runPythonComplexityTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  return runPythonMetricsTask(task, cwd, signal, "complexity");
}

async function runPythonSlocTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  return runPythonMetricsTask(task, cwd, signal, "sloc");
}

async function runPythonMaintainabilityTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  return runPythonMetricsTask(task, cwd, signal, "maintainability");
}

async function runPythonMetricsTask(
  task: PlannedTask,
  cwd: string,
  signal: AbortSignal | undefined,
  mode: SharedMetricsMode,
): Promise<StageResult> {
  const files = filterFiles(task.files, pythonExtensions);
  if (files.length === 0) {
    if (
      task.files.some(
        (file) =>
          isJavaScriptMetricsTaskFile(file) ||
          dotNetExtensions.has(path.extname(file).toLowerCase()) ||
          isGoTaskFile(file) ||
          isRustTaskFile(file) ||
          isJvmLanguageTaskFile(file),
      )
    ) {
      return createNoopStageResult(
        task.stageId,
        `No Python files were selected for ${task.stageId}.`,
      );
    }

    return createNotImplementedStageResult(
      task.stageId,
      createSharedMetricsNotImplementedNote(task.stageId),
    );
  }

  const unsupportedFiles = task.files.filter((file) => {
    const extension = path.extname(file).toLowerCase();
    return (
      !pythonExtensions.has(extension) &&
      !isJavaScriptMetricsTaskFile(file) &&
      !dotNetExtensions.has(extension) &&
      !isGoTaskFile(file) &&
      !isJvmLanguageTaskFile(file) &&
      !isRustTaskFile(file)
    );
  });
  const notes: string[] = [];
  const toolRuns: ToolRunResult[] = [];
  let totalDurationMs = 0;
  let totalSloc = 0;
  let totalBlocks = 0;
  let maxComplexity = 0;
  let maxRank = "A";
  let minMaintainability = Number.POSITIVE_INFINITY;
  let minMaintainabilityRank = "A";

  try {
    const projects = await resolvePythonProjects(files);
    for (const project of projects) {
      const cachedMetrics = await getPythonMetricsProjectMetrics(project, signal);
      totalDurationMs += cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs;
      toolRuns.push(
        createToolRunResult(
          "radon",
          cachedMetrics.metrics.args,
          cachedMetrics.cacheHit ? 0 : cachedMetrics.metrics.durationMs,
          cachedMetrics.metrics.exitCode,
          "passed",
          cachedMetrics.metrics.finishedAt,
          cachedMetrics.metrics.startedAt,
          cachedMetrics.cacheHit,
        ),
      );

      for (const fileMetrics of Object.values(cachedMetrics.metrics.files)) {
        totalSloc += fileMetrics.raw.sloc;
        totalBlocks += fileMetrics.cc.length;
        for (const block of fileMetrics.cc) {
          if (block.complexity > maxComplexity) {
            maxComplexity = block.complexity;
            maxRank = block.rank;
          }
        }

        if (fileMetrics.mi.score < minMaintainability) {
          minMaintainability = fileMetrics.mi.score;
          minMaintainabilityRank = fileMetrics.mi.rank;
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new AiqEngineCancelledError();
    }

    return createExecutionFailureStage(
      task.stageId,
      "radon",
      files[0] ?? cwd,
      error,
      totalDurationMs,
      [],
      toolRuns,
    );
  }

  notes.push(
    readSharedMetricsNote(
      "Python",
      mode,
      files.length,
      totalSloc,
      totalBlocks,
      maxComplexity,
      maxRank,
      minMaintainability,
      minMaintainabilityRank,
      "functions or classes",
    ),
  );

  if (toolRuns.some((toolRun) => toolRun.cacheHit)) {
    notes.push("Reused cached Python metrics for this file batch.");
  }

  if (unsupportedFiles.length > 0) {
    notes.push(
      `Stage '${task.stageId}' is not implemented yet for non-Python files in this selection: ${unsupportedFiles.join(", ")}.`,
    );
  }

  return {
    diagnostics: [],
    durationMs: totalDurationMs,
    notes,
    stageId: task.stageId,
    status: unsupportedFiles.length > 0 ? "not_implemented" : "passed",
    toolRuns,
  };
}

async function getPythonMetricsProjectMetrics(
  project: { files: string[]; projectRoot: string },
  signal?: AbortSignal,
): Promise<{ cacheHit: boolean; metrics: PythonMetricsProjectMetrics }> {
  const manifestKey = createPythonMetricsManifestKey(project);
  const cacheKey = await createPythonMetricsCacheKey(project, manifestKey);
  const cached = await getCachedRunnerValue("metrics:python", manifestKey, cacheKey, () =>
    runPythonMetricsProjectTask(project, signal),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

function createPythonMetricsManifestKey(project: { files: string[]; projectRoot: string }): string {
  return `${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

async function createPythonMetricsCacheKey(
  project: { files: string[]; projectRoot: string },
  manifestKey = createPythonMetricsManifestKey(project),
): Promise<string> {
  const fileEntries = await Promise.all(
    [...project.files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const fileStats = await stat(file);
        return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
      }),
  );

  return `${manifestKey}:${fileEntries.join("|")}`;
}

async function runPythonMetricsProjectTask(
  project: { files: string[]; projectRoot: string },
  signal?: AbortSignal,
): Promise<PythonMetricsProjectMetrics> {
  const script = [
    "import json, pathlib, sys",
    "from radon.complexity import cc_rank, cc_visit",
    "from radon.metrics import mi_rank, mi_visit",
    "from radon.raw import analyze",
    "files = [str(pathlib.Path(value).resolve()) for value in sys.argv[1:]]",
    "result = {}",
    "for file_path in files:",
    "    source = pathlib.Path(file_path).read_text(encoding='utf8')",
    "    raw = analyze(source)",
    "    blocks = cc_visit(source)",
    "    mi_score = float(mi_visit(source, True))",
    "    result[file_path] = {",
    "        'raw': {",
    "            'blank': raw.blank,",
    "            'comments': raw.comments,",
    "            'lloc': raw.lloc,",
    "            'loc': raw.loc,",
    "            'multi': raw.multi,",
    "            'singleComments': raw.single_comments,",
    "            'sloc': raw.sloc,",
    "        },",
    "        'cc': [",
    "            {",
    "                'complexity': block.complexity,",
    "                'endline': block.endline,",
    "                'lineno': block.lineno,",
    "                'name': block.name,",
    "                'rank': cc_rank(block.complexity),",
    "                'type': block.__class__.__name__,",
    "            }",
    "            for block in blocks",
    "        ],",
    "        'mi': {",
    "            'rank': mi_rank(mi_score),",
    "            'score': mi_score,",
    "        },",
    "    }",
    "print(json.dumps(result))",
  ].join("\n");
  const args = ["-c", script, ...project.files];
  const outcome = await runExecutable(
    binaries.resolvePythonCommand(),
    args,
    project.projectRoot,
    signal,
  );

  if (outcome.exitCode !== 0) {
    throw new Error(
      readProcessFailureMessage("radon", outcome.stderr, outcome.stdout, outcome.exitCode),
    );
  }

  return {
    args,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    files: parsers.parsePythonMetrics(outcome.stdout),
    finishedAt: outcome.finishedAt,
    startedAt: outcome.startedAt,
  };
}

async function resolvePythonProjects(
  files: readonly string[],
): Promise<Array<{ files: string[]; projectRoot: string }>> {
  const graph = getRunnerGraph();
  if (graph !== undefined) {
    return selectGraphPythonProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();

  for (const file of files) {
    const projectRoot =
      (await findNearestAnyConfig(file, pythonTaskConfigNames)) ?? path.dirname(file);
    const existingFiles = projectFiles.get(projectRoot);
    if (existingFiles === undefined) {
      projectFiles.set(projectRoot, [file]);
      continue;
    }

    existingFiles.push(file);
  }

  return [...projectFiles.entries()]
    .map(([projectRoot, projectRootFiles]) => ({
      files: [...projectRootFiles].sort((left, right) => left.localeCompare(right)),
      projectRoot,
    }))
    .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
}

function readProjectConcurrencyLimit(): number {
  return resolveProjectConcurrencyLimit();
}

async function runProjectBatches<TProject, TResult>(
  projects: readonly TProject[],
  runProject: (project: TProject) => Promise<TResult>,
  concurrencyLimit = readProjectConcurrencyLimit(),
): Promise<TResult[]> {
  const results: TResult[] = [];

  for (let index = 0; index < projects.length; index += concurrencyLimit) {
    const projectBatch = projects.slice(index, index + concurrencyLimit);
    results.push(...(await Promise.all(projectBatch.map((project) => runProject(project)))));
  }

  return results;
}

function readPythonUnitNote(summary: { failed: number; passed: number; total: number }): string {
  if (summary.total === 0) {
    return "Pytest found no tests.";
  }

  return `Pytest ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readPythonCoverageNote(
  coverageSummary: Record<string, unknown> | undefined,
  summary: { failed: number; passed: number; total: number },
): string {
  if (summary.total === 0) {
    return "Pytest found no tests.";
  }

  const totalCoverage = readCoverageMetric(coverageSummary, "totals", "percent_covered");
  if (totalCoverage === undefined) {
    return `Pytest coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }

  return `Pytest coverage lines: ${totalCoverage.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

function readCoverageMetric(
  summary: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }

  const value = readNestedValue(summary, keys);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readJsonValue(filePath: string): Promise<unknown> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }

  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  const parsed = await readJsonValue(filePath);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  return parsed as Record<string, unknown>;
}

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
function parseStylelintDiagnostics(report: string, cwd: string): Diagnostic[] {
  return parsers.parseStylelintDiagnostics(report, cwd);
}

function createFormattingDiagnostic(file: string, source: string): Diagnostic {
  return {
    file,
    message: "File requires formatting.",
    severity: "error",
    source,
  };
}

function createPrettierDiagnostic(file: string, error: unknown): Diagnostic {
  const diagnostic: Diagnostic = {
    file,
    message: formatError(error).trim() || "Prettier could not parse the file.",
    severity: "error",
    source: "prettier",
  };

  if (typeof error !== "object" || error === null || !("loc" in error)) {
    return diagnostic;
  }

  const location = (
    error as {
      loc?: {
        end?: { column?: number; line?: number };
        start?: { column?: number; line?: number };
      };
    }
  ).loc;
  const startLine = readNumber(location?.start?.line);
  const startColumn = readNumber(location?.start?.column);
  const endLine = readNumber(location?.end?.line);
  const endColumn = readNumber(location?.end?.column);
  if (startLine !== undefined && startColumn !== undefined) {
    diagnostic.range = {
      ...(endColumn === undefined ? {} : { endColumn }),
      ...(endLine === undefined ? {} : { endLine }),
      startColumn,
      startLine,
    };
  }

  return diagnostic;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function measureOperation<T>(operation: () => Promise<T>): Promise<{
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

function resolveMavenCommand(): string {
  return binaries.resolveMavenCommand();
}

function resolveGradleCommand(): string {
  return binaries.resolveGradleCommand();
}

async function resolveInstalledBinary(commandName: string): Promise<string | undefined> {
  return getRunnerToolRunner().resolveInstalledBinary(commandName);
}

async function resolveBinaryIfAvailable(
  commandNames: readonly string[],
): Promise<string | undefined> {
  return getRunnerToolRunner().resolveBinaryIfAvailable(commandNames);
}

async function resolveRequiredBinary(
  commandNames: readonly string[],
  toolName: string,
  installMessage: string,
): Promise<string> {
  return getRunnerToolRunner().resolveRequiredBinary(commandNames, toolName, installMessage);
}

async function resolvePowerShellModuleManifest(moduleName: string): Promise<string | undefined> {
  return getRunnerToolRunner().resolvePowerShellModuleManifest(moduleName);
}

async function resolveRequiredPowerShellModuleManifest(moduleName: string): Promise<string> {
  return getRunnerToolRunner().resolveRequiredPowerShellModuleManifest(moduleName);
}

async function runPowerShellScript(
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

function isMissingCommandOutcome(
  stderr: string,
  stdout: string,
  exitCode: number | undefined,
): boolean {
  return getRunnerToolRunner().isMissingCommandOutcome(stderr, stdout, exitCode);
}

async function createRustProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  return getRunnerToolRunner().createRustProcessEnv();
}

async function createJvmProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  return getRunnerToolRunner().createJvmProcessEnv();
}

function resolveUvxCommand(): string {
  return binaries.resolveUvxCommand();
}

function resolveDotNetCommand(): string {
  return binaries.resolveDotNetCommand();
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

function createUnsupportedJavaScriptRunnerNote(
  stageId: StageId,
  projectRoots: readonly string[],
): string {
  if (projectRoots.length === 0) {
    return `No JavaScript or TypeScript project roots were detected for ${stageId}.`;
  }

  return `No supported JavaScript or TypeScript test runner was detected for ${stageId} in: ${projectRoots.join(", ")}.`;
}

function createSharedMetricsNotImplementedNote(stageId: StageId): string {
  return `Stage '${stageId}' is currently implemented only for Python, JavaScript, TypeScript, C#, Go, Rust, Java, and Kotlin files in the rewrite foundation slice.`;
}

function readSharedMetricsNote(
  languageLabel: string,
  mode: SharedMetricsMode,
  fileCount: number,
  totalSloc: number,
  totalBlocks: number,
  maxComplexity: number,
  maxRank: string,
  minMaintainability: number,
  minMaintainabilityRank: string,
  emptyBlockLabel: string,
): string {
  if (mode === "sloc") {
    return `${languageLabel} SLOC: ${totalSloc} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`;
  }

  if (mode === "complexity") {
    return totalBlocks === 0
      ? `${languageLabel} complexity scanned ${fileCount} file${fileCount === 1 ? "" : "s"}; no ${emptyBlockLabel} were detected. Shared metrics observed ${totalSloc} SLOC.`
      : `${languageLabel} complexity max: ${maxComplexity} (${maxRank}) across ${totalBlocks} block${totalBlocks === 1 ? "" : "s"}; Shared metrics observed ${totalSloc} SLOC.`;
  }

  return Number.isFinite(minMaintainability)
    ? `${languageLabel} maintainability min: ${minMaintainability.toFixed(1)} (${minMaintainabilityRank}) across ${fileCount} file${fileCount === 1 ? "" : "s"}.`
    : `${languageLabel} maintainability scanned ${fileCount} file${fileCount === 1 ? "" : "s"}.`;
}

export function createNoopStageResult(stageId: StageId, note: string): StageResult {
  return {
    diagnostics: [],
    durationMs: 0,
    notes: [note],
    stageId,
    status: "passed",
    toolRuns: [],
  };
}

export function combineStageResults(
  stageId: StageId,
  results: readonly StageResult[],
): StageResult {
  const activeResults = results.filter((result) => !isNoopStageResult(result));
  if (activeResults.length === 0) {
    return createNoopStageResult(stageId, `No supported files were selected for ${stageId}.`);
  }

  return {
    diagnostics: activeResults.flatMap((result) => result.diagnostics),
    durationMs: activeResults.reduce((total, result) => total + result.durationMs, 0),
    notes: activeResults.flatMap((result) => result.notes),
    stageId,
    status: summarizeCombinedStageStatus(activeResults),
    toolRuns: activeResults.flatMap((result) => result.toolRuns),
  };
}

export function isNoopStageResult(result: StageResult): boolean {
  return (
    result.status === "passed" &&
    result.durationMs === 0 &&
    result.diagnostics.length === 0 &&
    result.toolRuns.length === 0
  );
}

export function summarizeCombinedStageStatus(
  results: readonly StageResult[],
): StageResult["status"] {
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (results.some((result) => result.status === "not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}

function createToolRunResult(
  tool: string,
  args: string[],
  durationMs: number,
  exitCode: number | undefined,
  status: ToolRunStatus,
  finishedAt?: string,
  startedAt?: string,
  cacheHit = false,
): ToolRunResult {
  const result: ToolRunResult = {
    args,
    cacheHit,
    durationMs,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    status,
    tool,
  };

  if (exitCode !== undefined) {
    result.exitCode = exitCode;
  }

  return result;
}

function createExecutionFailureStage(
  stageId: StageId,
  tool: string,
  file: string,
  error: unknown,
  durationMs = 0,
  diagnostics: Diagnostic[] = [],
  toolRuns: ToolRunResult[] = [],
): StageResult {
  const message = formatError(error);

  return {
    diagnostics: [...diagnostics, createProcessFailureDiagnostic(file, tool, message)],
    durationMs,
    notes: [message],
    stageId,
    status: "failed",
    toolRuns,
  };
}

function createProcessFailureDiagnostic(file: string, source: string, message: string): Diagnostic {
  return {
    file,
    message,
    severity: "error",
    source,
  };
}

function filterFiles(files: readonly string[], supportedExtensions: ReadonlySet<string>): string[] {
  return files.filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()));
}

function readProcessFailureMessage(
  toolName: string,
  stderr: string,
  stdout: string,
  exitCode: number | undefined,
): string {
  return getRunnerToolRunner().readProcessFailureMessage(toolName, stderr, stdout, exitCode);
}

function joinOutputs(...values: string[]): string {
  return getRunnerToolRunner().joinOutputs(...values);
}

function resolvePackageBinaryPath(
  packageJsonSpecifier: string,
  relativeBinaryPath: string,
): string {
  return binaries.resolvePackageBinaryPath(packageJsonSpecifier, relativeBinaryPath);
}

async function runNodeTool(
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

async function runExecutable(
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

function isAbortError(error: unknown): boolean {
  return getRunnerToolRunner().isAbortError(error);
}

function throwIfAbortError(error: unknown): void {
  if (isAbortError(error)) {
    throw new AiqEngineCancelledError();
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
