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

type BiomeTaskKind = "format" | "lint";

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
    const status = readBiomeStatus(outcome.exitCode, diagnostics.length);
    addMissingBiomeDiagnostic(diagnostics, {
      cwd,
      exitCode: outcome.exitCode,
      files,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      toolName: "Biome",
    });

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      notes: readBiomeNotes("lint", status, configPath, diagnostics.length),
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
    const status = readBiomeStatus(outcome.exitCode, diagnostics.length);
    addMissingBiomeDiagnostic(diagnostics, {
      cwd,
      exitCode: outcome.exitCode,
      files,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      toolName: "Biome format",
    });

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      notes: readBiomeNotes("format", status, configPath, diagnostics.length),
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

function readBiomeStatus(exitCode: number | undefined, diagnosticCount: number): StageResult["status"] {
  return exitCode === 0 && diagnosticCount === 0 ? "passed" : "failed";
}

function addMissingBiomeDiagnostic(
  diagnostics: ReturnType<typeof parsers.parseBiomeDiagnostics>,
  options: {
    cwd: string;
    exitCode: number | undefined;
    files: readonly string[];
    stderr: string;
    stdout: string;
    toolName: string;
  },
): void {
  if (options.exitCode === 0 || diagnostics.length > 0) {
    return;
  }

  diagnostics.push(
    createProcessFailureDiagnostic(
      options.files[0] ?? options.cwd,
      "biome",
      readProcessFailureMessage(
        options.toolName,
        options.stderr,
        options.stdout,
        options.exitCode,
      ),
    ),
  );
}

function readBiomeNotes(
  kind: BiomeTaskKind,
  status: StageResult["status"],
  configPath: string | undefined,
  diagnosticCount: number,
): string[] {
  return status === "passed"
    ? [readBiomePassedNote(kind, configPath)]
    : [readBiomeFailureNote(kind, diagnosticCount)];
}

function readBiomePassedNote(kind: BiomeTaskKind, configPath: string | undefined): string {
  const label = kind === "lint" ? "Biome lint" : "Biome format";
  return configPath === undefined ? `${label} passed.` : `${label} passed using ${configPath}.`;
}

function readBiomeFailureNote(kind: BiomeTaskKind, diagnosticCount: number): string {
  const label = kind === "lint" ? "diagnostic" : "formatting diagnostic";
  return `Biome reported ${diagnosticCount} ${label}${diagnosticCount === 1 ? "" : "s"}.`;
}
