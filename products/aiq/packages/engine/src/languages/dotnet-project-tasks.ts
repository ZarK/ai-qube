import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import * as commands from "../tools/command-builders.js";
import type { DotNetRunnerRuntime } from "./contracts.js";
import type { DotNetProject } from "./dotnet.js";
import {
  findFirstFile,
  normalizeDotNetDiagnosticsToSelection as normalizeDiagnosticsToSelection,
  readDotNetCoverageNote,
  readDotNetUnitNote,
  readJsonValue,
  readOptionalTextFile,
} from "./dotnet-tool-utils.js";

export async function runDotNetFormatProject(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
  options: {
    failureLabel: string;
    noteLabel: string;
    subcommand: "style" | "whitespace";
    tool: string;
  },
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-format-"));

  try {
    const reportDir = path.join(tempDir, "report");
    const args = commands.createDotNetFormatArgs({
      reportDir,
      subcommand: options.subcommand,
      targetPath: project.targetPath,
      verifyNoChanges: true,
    });
    const outcome = await runtime.runExecutable(
      runtime.resolveDotNetCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = await readJsonValue(path.join(reportDir, "format-report.json"));
    const parsedDiagnostics = normalizeDiagnosticsToSelection(
      parsers.parseDotNetFormatDiagnostics(report, project.projectRoot),
      project.files,
    );
    const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && parsedDiagnostics.length === 0) {
      parsedDiagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.targetPath,
          "dotnet-format",
          runtime.readProcessFailureMessage(
            options.failureLabel,
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
      note:
        status === "passed"
          ? `${options.noteLabel} passed for ${path.basename(project.targetPath)}.`
          : `${options.noteLabel} reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.targetPath)}.`,
      toolRun: runtime.createToolRunResult(
        options.tool,
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runDotNetTypecheckProject(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-build-"));

  try {
    const sarifPath = path.join(tempDir, "build.sarif.json");
    const args = commands.createDotNetBuildArgs({
      errorLog: sarifPath,
      nologo: true,
      targetPath: project.targetPath,
      verbosity: "minimal",
    });
    const outcome = await runtime.runExecutable(
      runtime.resolveDotNetCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = await readJsonValue(sarifPath);
    const parsedDiagnostics = normalizeDiagnosticsToSelection(
      parsers.parseDotNetSarifDiagnostics(report, project.projectRoot),
      project.files,
    );

    if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
      parsedDiagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.files[0] ?? project.targetPath,
          "dotnet-build",
          runtime.readProcessFailureMessage(
            "dotnet build",
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
      note:
        parsedDiagnostics.length === 0
          ? `dotnet build passed for ${path.basename(project.targetPath)}.`
          : `dotnet build reported ${parsedDiagnostics.length} diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${path.basename(project.targetPath)}.`,
      toolRun: runtime.createToolRunResult(
        "dotnet-build",
        args,
        outcome.durationMs,
        outcome.exitCode,
        outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runDotNetProjectTestTask(
  project: DotNetProject,
  mode: "coverage" | "unit",
  runtime: DotNetRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  toolRun: ToolRunResult;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-test-"));

  try {
    const trxPath = path.join(tempDir, "results.trx");
    const args = commands.createDotNetTestArgs({
      logger: `trx;LogFileName=${path.basename(trxPath)}`,
      nologo: true,
      resultsDir: tempDir,
      targetPath: project.targetPath,
      verbosity: "minimal",
    });
    if (mode === "coverage") {
      args.push("--collect", "XPlat Code Coverage");
    }

    const outcome = await runtime.runExecutable(
      runtime.resolveDotNetCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    const report = parsers.parseDotNetTrxReport(
      await readOptionalTextFile(trxPath),
      project.projectRoot,
    );
    const coveragePercent = await readDotNetTestCoveragePercent(mode, tempDir);
    const status = outcome.exitCode === 0 && report.diagnostics.length === 0 ? "passed" : "failed";
    appendSilentDotNetTestFailureDiagnostic({ outcome, project, report, runtime, status });

    return {
      diagnostics: report.diagnostics,
      durationMs: outcome.durationMs,
      note: readDotNetTestNote(mode, report.summary, coveragePercent),
      toolRun: runtime.createToolRunResult(
        readDotNetTestTool(mode),
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function readDotNetTestCoveragePercent(
  mode: "coverage" | "unit",
  tempDir: string,
): Promise<number | undefined> {
  if (mode !== "coverage") {
    return undefined;
  }

  const coverageReportPath = await findFirstFile(tempDir, (filePath) =>
    filePath.endsWith("coverage.cobertura.xml"),
  );
  return parsers.readCoberturaLineRate(
    coverageReportPath === undefined ? undefined : await readOptionalTextFile(coverageReportPath),
  );
}

function appendSilentDotNetTestFailureDiagnostic(options: {
  outcome: Awaited<ReturnType<DotNetRunnerRuntime["runExecutable"]>>;
  project: DotNetProject;
  report: ReturnType<typeof parsers.parseDotNetTrxReport>;
  runtime: DotNetRunnerRuntime;
  status: "failed" | "passed";
}): void {
  if (options.status !== "failed" || options.report.diagnostics.length > 0) {
    return;
  }

  options.report.diagnostics.push(
    options.runtime.createProcessFailureDiagnostic(
      options.project.files[0] ?? options.project.targetPath,
      "dotnet-test",
      options.runtime.readProcessFailureMessage(
        "dotnet test",
        options.outcome.stderr,
        options.outcome.stdout,
        options.outcome.exitCode,
      ),
    ),
  );
}

function readDotNetTestNote(
  mode: "coverage" | "unit",
  summary: Parameters<typeof readDotNetCoverageNote>[0],
  coveragePercent: number | undefined,
): string {
  return mode === "coverage"
    ? readDotNetCoverageNote(summary, coveragePercent)
    : readDotNetUnitNote(summary);
}

function readDotNetTestTool(mode: "coverage" | "unit"): "dotnet-test" | "dotnet-test-coverage" {
  return mode === "coverage" ? "dotnet-test-coverage" : "dotnet-test";
}
