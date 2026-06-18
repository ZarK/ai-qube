import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runBenchmarkSuite } from "@tjalve/aiq/benchmark";
import {
  initializeAiqProjectConfig,
  loadAiqProgress,
  resolveAiqConfig,
  setAiqProgressStage,
} from "@tjalve/aiq/config";
import {
  createRunPlan,
  resolvePlanArtifactPath,
  resolveReportArtifactPath,
  runEngine,
  writePlanArtifact,
} from "@tjalve/aiq/engine";
import type { LanguageId, RunRequest, RunResult, StageId } from "@tjalve/aiq/model";

import { createAiqQualityEvidence, formatAiqQualityEvidenceJson } from "./evidence.js";
import {
  collectFirstRunManifestFiles,
  createFirstRunSetupGuidance,
  formatFirstRunDetectedProjects,
  inferFirstRunProjects,
  writeFirstRunJsonPrelude,
} from "./first-run.js";
import { detectNativeConfigs, resolveDoctorNativeConfigChecks } from "./native-config.js";
import {
  type DoctorCheckOutput,
  type DoctorCommandOutput,
  type SetupCommandOutput,
  formatBenchmarkOutput,
  formatConfigInitOutput,
  formatConfigOutput,
  formatConfigStageOutput,
  formatDoctorOutput,
  formatDryRunOutput,
  formatFirstRunDetectionOutput,
  formatFirstRunResultDetails,
  formatFirstRunSetupOutput,
  formatPlanOutput,
  formatRunResultOutput,
  formatSetupGuidanceOutput,
  formatSetupOutput,
  formatStatusOutput,
  toWorkflowStageOutput,
} from "./output.js";
import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";
import { createRunRequest, resolveCliConfig } from "./requests.js";
import { renderAiqCommandSchemaJson } from "./schema.js";
import { formatError, isErrorCode } from "./shared.js";
import {
  type CliIo,
  type ParsedArgs,
  type SetupGuidanceCommand,
  cliStageShortcutIds,
} from "./types.js";
import { createDefaultRunOutput, createRunWorkflowOutput, resolveNextCommand } from "./workflow.js";
export { runDoctorCommand, runSetupCommand } from "./doctor-command.js";
export { runStatusCommand } from "./status-command.js";
import { loadOptionalRunProgress } from "./status-command.js";


export async function runBenchCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const { report } = await runBenchmarkSuite({
      ...(parsed.benchmarkCorpusRoot === undefined
        ? {}
        : { corpusRoot: parsed.benchmarkCorpusRoot }),
      cwd: io.cwd,
      ...(parsed.benchmarkKinds.length === 0 ? {} : { kinds: parsed.benchmarkKinds }),
      ...(parsed.outDir === undefined ? {} : { outDir: parsed.outDir }),
      ...(parsed.benchmarkScenarioIds.length === 0
        ? {}
        : { scenarioIds: parsed.benchmarkScenarioIds }),
      ...(parsed.benchmarkTags.length === 0 ? {} : { tags: parsed.benchmarkTags }),
    });
    io.stdout.write(formatBenchmarkOutput(parsed.format, report));
    return report.summary.failedBudgetCount === 0 ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export async function runConfigCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    if (parsed.configSetStage !== undefined) {
      const progress = await setAiqProgressStage(io.cwd, parsed.configSetStage);
      io.stdout.write(
        formatConfigStageOutput(parsed.format, {
          current_stage: progress.progress.current_stage,
          progressPath: progress.path,
        }),
      );
      return 0;
    }

    if (parsed.configPrint) {
      const [resolvedConfig, loadedProgress] = await Promise.all([
        resolveAiqConfig({ cwd: io.cwd, surface: "cli" }),
        loadAiqProgress(io.cwd),
      ]);
      io.stdout.write(
        formatConfigOutput(parsed.format, {
          config: resolvedConfig.config,
          ...(resolvedConfig.configPath === undefined
            ? {}
            : { configPath: resolvedConfig.configPath }),
          progress: loadedProgress.progress,
          progressPath: loadedProgress.path,
          progressSource: loadedProgress.source,
          profile: resolvedConfig.profile,
          stages: resolvedConfig.stages,
        }),
      );
      return 0;
    }

    const result = await initializeAiqProjectConfig(io.cwd);
    io.stdout.write(formatConfigInitOutput(parsed.format, result));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export async function runPlanCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  let request: RunRequest;
  try {
    request = await createRunRequest(parsed, io, {
      context: "cli",
      includeProgressStage: true,
      mode: "plan",
      surface: "cli",
    });
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }

  try {
    const plan = await createRunPlan(request);
    if (request.writeArtifacts !== false) {
      await writePlanArtifact(plan, plan.artifacts.outDir);
    }
    io.stdout.write(formatPlanOutput(parsed.format, plan));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}


export function runSetupGuidanceCommand(parsed: ParsedArgs, io: CliIo): number {
  const command = parsed.command as SetupGuidanceCommand;
  const output = createSetupGuidanceOutput(command, parsed.setupSubcommand);
  io.stdout.write(formatSetupGuidanceOutput(parsed.format, output));
  return 0;
}

export function runSchemaCommand(_parsed: ParsedArgs, io: CliIo): number {
  io.stdout.write(renderAiqCommandSchemaJson());
  return 0;
}

export async function runEvidenceCommand(_parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    const evidence = await createAiqQualityEvidence(io.cwd);
    io.stdout.write(formatAiqQualityEvidenceJson(evidence));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }
}

export async function runFirstRunCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  let projects: Awaited<ReturnType<typeof inferFirstRunProjects>>;
  try {
    projects = await inferFirstRunProjects(io.cwd);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 3;
  }

  if (projects.length === 0) {
    io.stdout.write(formatFirstRunSetupOutput(parsed.format, createFirstRunSetupGuidance(io.cwd)));
    return 2;
  }

  let initialization: Awaited<ReturnType<typeof initializeAiqProjectConfig>>;
  let request: RunRequest;
  try {
    initialization = await initializeAiqProjectConfig(io.cwd);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 3;
  }

  let manifestCollection: Awaited<ReturnType<typeof collectFirstRunManifestFiles>>;
  try {
    manifestCollection = await collectFirstRunManifestFiles(io.cwd, projects);
    const firstRunParsed: ParsedArgs = {
      ...parsed,
      command: "run",
      files: manifestCollection.files,
    };
    request = await createRunRequest(firstRunParsed, io, {
      context: "cli",
      includeProgressStage: !initialization.progressCreated,
      mode: "check",
      surface: "cli",
    });
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }

  io.stdout.write(
    formatFirstRunDetectionOutput(parsed.format, {
      configCreated: initialization.configCreated,
      configPath: initialization.configPath,
      detectedProjects: formatFirstRunDetectedProjects(projects, io.cwd),
      progressCreated: initialization.progressCreated,
      progressPath: initialization.progressPath,
      stages: [...(request.stages ?? [])],
      target: ".",
      truncated: manifestCollection.truncated,
      warnings: manifestCollection.warnings,
    }),
  );

  try {
    if (parsed.dryRun) {
      request.writeArtifacts = false;
      const plan = await createRunPlan(request);
      io.stdout.write(formatDryRunOutput(parsed.format, plan));
      return 0;
    }

    const result = await runEngine(request);
    io.stdout.write(
      writeFirstRunJsonPrelude(parsed.format)
        ? formatRunResultOutput(parsed.format, result)
        : formatRunResultOutput(parsed.format, result, "run", { verbose: parsed.verbose }),
    );
    if (parsed.format === "text") {
      io.stdout.write(formatFirstRunResultDetails(result));
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 3;
  }
}

export async function runCheckCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const outputCommand = parsed.command === "run" ? "run" : "check";
  let request: RunRequest;
  let loadedProgress: Awaited<ReturnType<typeof loadAiqProgress>> | undefined;
  try {
    request = await createRunRequest(parsed, io, {
      context: "cli",
      includeProgressStage: true,
      mode: "check",
      surface: "cli",
    });
    loadedProgress = await loadOptionalRunProgress(parsed, io);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 2;
  }

  try {
    if (parsed.dryRun) {
      request.writeArtifacts = false;
      const plan = await createRunPlan(request);
      io.stdout.write(formatDryRunOutput(parsed.format, plan));
      return 0;
    }

    const result = await runEngine(request);
    io.stdout.write(
      formatRunResultOutput(parsed.format, result, outputCommand, {
        verbose: parsed.verbose,
        ...(loadedProgress === undefined
          ? {}
          : { workflow: createRunWorkflowOutput(loadedProgress, request, result) }),
      }),
    );
    return result.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function createSetupGuidanceOutput(command: SetupGuidanceCommand, subcommand?: string) {
  switch (command) {
    case "hook":
      return {
        command,
        requested: `hook ${subcommand ?? ""}`.trim(),
        summary: "Hook setup uses the dedicated AIQ hook adapter.",
        replacement:
          "Use your repository hook manager to invoke the aiq-hook package, or run aiq check/run directly in pre-commit automation.",
      };
    case "ci":
      return {
        command,
        requested: `ci ${subcommand ?? ""}`.trim(),
        summary: "CI setup uses explicit workflow configuration.",
        replacement:
          "Use npx @tjalve/aiq run <files> in CI and keep stage/profile selection in .aiq/aiq.config.json.",
      };
    case "ignore":
      return {
        command,
        requested: `ignore ${subcommand ?? ""}`.trim(),
        summary: "Ignored inputs are configured in the canonical AIQ config file.",
        replacement:
          "Run aiq config to initialize .aiq/aiq.config.json, then edit inputs.ignore there so the ignored paths are reviewed with project config.",
      };
  }
}
