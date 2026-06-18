import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  Diagnostic,
  EngineContext,
  PlannedTask,
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
  SharedMetricsMode,
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
import {
  runPythonComplexityTask as runPythonComplexityLanguageTask,
  runPythonCoverageTask as runPythonCoverageLanguageTask,
  runPythonFormatTask as runPythonFormatLanguageTask,
  runPythonLintTask as runPythonLintLanguageTask,
  runPythonMaintainabilityTask as runPythonMaintainabilityLanguageTask,
  runPythonSlocTask as runPythonSlocLanguageTask,
  runPythonTypecheckTask as runPythonTypecheckLanguageTask,
  runPythonUnitTask as runPythonUnitLanguageTask,
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
  runTerraformFormatTask as runTerraformFormatLanguageTask,
  runTerraformLintTask as runTerraformLintLanguageTask,
  runTerraformTypecheckTask as runTerraformTypecheckLanguageTask,
} from "./languages/terraform.js";
import { runTypeScriptTypecheckTask as runTypeScriptTypecheckLanguageTask } from "./languages/typescript.js";
import * as parsers from "./parsers/index.js";
import { type Registry, createRegistry } from "./registries.js";
import { runBiomeFormatTask, runBiomeLintTask } from "./runner-biome-tasks.js";
import {
  runPrettierDocumentFormatTask,
  runSqlFormatTask,
} from "./runner-document-format-tasks.js";
import {
  runCssLintTask,
  runHtmlLintTask,
  runSqlLintTask,
  runYamlLintTask,
} from "./runner-document-lint-tasks.js";
import {
  createBashRunnerRuntime,
  createDotNetRunnerRuntime,
  createGoRunnerRuntime,
  createHashicorpRunnerRuntime,
  createJavaScriptRunnerRuntime,
  createJvmRunnerRuntime,
  createPowerShellRunnerRuntime,
  createPythonRunnerRuntime,
  createRustRunnerRuntime,
  createTypeScriptRunnerRuntime,
} from "./runner-runtimes.js";
import {
  biomeExtensions,
  cssExtensions,
  filterFilesForConfiguredToolLanguages,
  groupConfiguredStageLanguages,
  htmlExtensions,
  isSharedMetricsSupportedFile,
  prettierDocumentExtensions,
  securityExtensions,
  sharedBiomeExtensions,
  shouldSkipScriptProjectDirectory,
  sqlExtensions,
  yamlExtensions,
} from "./runner-file-rules.js";
import {
  createRunnerExecutionContext,
  getCachedRunnerValue,
  getRunnerExecutionContext,
  getRunnerGraph,
  getRunnerRunScopedValue,
  getRunnerSelectedStages,
  getRunnerStageConfigurations,
  getRunnerToolRunner,
  resetRunnerRunScopedValues,
  runnerExecutionContextStorage,
  setRunnerRunScopedValue,
} from "./runner-context.js";
import {
  combineStageResults,
  createExecutionFailureStage,
  createNoopStageResult,
  createNotImplementedStageResult,
  createProcessFailureDiagnostic,
  createSharedMetricsNotImplementedNote,
  createToolRunResult,
  formatError,
  isNoopStageResult,
  readSharedMetricsNote,
  summarizeCombinedStageStatus,
} from "./runner-results.js";
import {
  createJvmProcessEnv,
  createRustProcessEnv,
  createUnsupportedJavaScriptRunnerNote,
  filterFiles,
  findFirstFile,
  findMatchingFiles,
  findSharedNativeConfig,
  isMissingCommandOutcome,
  joinOutputs,
  measureOperation,
  normalizeLineEndings,
  readNumber,
  readProcessFailureMessage,
  resolveBinaryIfAvailable,
  resolveDotNetCommand,
  resolveGradleCommand,
  resolveInstalledBinary,
  resolveMavenCommand,
  resolvePackageBinaryPath,
  resolvePowerShellModuleManifest,
  resolveRequiredBinary,
  resolveRequiredPowerShellModuleManifest,
  resolveUvxCommand,
  runExecutable,
  runNodeTool,
  runPowerShellScript,
  throwIfAbortError,
} from "./runner-toolbox.js";
import { runSharedSecurityTask } from "./runner-security-task.js";
import { pathExists } from "./utils/path-utils.js";

export {
  combineStageResults,
  createNoopStageResult,
  createNotImplementedStageResult,
  createRunnerExecutionContext,
  isNoopStageResult,
  resetRunnerRunScopedValues,
  runnerExecutionContextStorage,
  summarizeCombinedStageStatus,
};

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
    return combineStageResults(task.stageId, []);
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
