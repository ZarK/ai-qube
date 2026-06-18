import type { PlannedTask, StageResult } from "./contracts.js";
import * as parsers from "./parsers/index.js";
import { biomeExtensions } from "./runner-file-rules.js";
import {
  createExecutionFailureStage,
  createNoopStageResult,
  createProcessFailureDiagnostic,
  createToolRunResult,
} from "./runner-results.js";
import {
  filterFiles,
  findSharedNativeConfig,
  readProcessFailureMessage,
  resolvePackageBinaryPath,
  runNodeTool,
  throwIfAbortError,
} from "./runner-toolbox.js";
import * as commands from "./tools/command-builders.js";
import { findNearestBiomeConfig } from "./tools/native-config.js";

export async function runBiomeLintTask(
  task: PlannedTask,
  cwd: string,
  signal?: AbortSignal,
): Promise<StageResult> {
  const files = filterFiles(task.files, biomeExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No Biome-supported files were selected for lint.");
  }

  const configPath = await findSharedNativeConfig(files, findNearestBiomeConfig);
  const args = commands.createBiomeLintArgs({
    ...(configPath === undefined ? {} : { configPath }),
    files,
  });

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
          ? [configPath === undefined ? "Biome lint passed." : `Biome lint passed using ${configPath}.`]
          : [`Biome reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
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
    throwIfAbortError(error);
    return createExecutionFailureStage(task.stageId, "biome", files[0] ?? cwd, error);
  }
}

export async function runBiomeFormatTask(
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

  const configPath = await findSharedNativeConfig(files, findNearestBiomeConfig);
  const args = commands.createBiomeFormatArgs({
    ...(configPath === undefined ? {} : { configPath }),
    files,
  });

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
          ? [configPath === undefined ? "Biome format passed." : `Biome format passed using ${configPath}.`]
          : [`Biome reported ${diagnostics.length} formatting diagnostic${diagnostics.length === 1 ? "" : "s"}.`],
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
    throwIfAbortError(error);
    return createExecutionFailureStage(task.stageId, "biome", files[0] ?? cwd, error);
  }
}
