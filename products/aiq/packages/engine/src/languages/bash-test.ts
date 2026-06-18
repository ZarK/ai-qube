import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import { pathExists } from "../utils/path-utils.js";
import type { BashRunnerRuntime } from "./contracts.js";
import {
  type ScriptProject,
  createMissingScriptTestsNote,
  resolveBashProjectTestFiles,
} from "./script.js";

export async function runBashProjectTestTask(
  project: ScriptProject,
  mode: "coverage" | "unit",
  runtime: BashRunnerRuntime,
): Promise<{
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  status: StageResult["status"];
  toolRuns: ToolRunResult[];
}> {
  const testFiles = await resolveBashProjectTestFiles(project, runtime.findMatchingFiles);
  if (testFiles.length === 0) {
    return createBashTestSetupFailure(
      project,
      "bats",
      `${createMissingScriptTestsNote("Bash", project.projectRoot)} Add .bats tests or disable Bash ${mode}.`,
      runtime,
    );
  }

  const batsCommand = await runtime.resolveBinaryIfAvailable(
    process.platform === "win32" ? ["bats.exe", "bats"] : ["bats"],
  );
  if (batsCommand === undefined) {
    return createBashTestSetupFailure(
      project,
      "bats",
      `Bats is required for Bash ${mode} and was not detected in ${project.projectRoot}. Install Bats or disable Bash ${mode}.`,
      runtime,
    );
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-bash-runner-"));

  try {
    const junitPath = path.join(tempDir, "report.xml");
    const relativeTestFiles = testFiles.map((file) => path.relative(project.projectRoot, file));

    if (mode === "unit") {
      const args = ["--report-formatter", "junit", "--output", tempDir, ...relativeTestFiles];
      const outcome = await runtime.runExecutable(
        batsCommand,
        args,
        project.projectRoot,
        runtime.signal,
      );
      const report = await parsers.parseJvmJunitReports(
        [junitPath],
        testFiles[0] ?? project.projectRoot,
        readOptionalTextFile,
      );
      const diagnostics: Diagnostic[] = report.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        source: "bats",
      }));
      const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

      if (status === "failed" && diagnostics.length === 0) {
        diagnostics.push(
          runtime.createProcessFailureDiagnostic(
            testFiles[0] ?? project.projectRoot,
            "bats",
            runtime.readProcessFailureMessage(
              "bats",
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
        note: readBashUnitNote(report.summary),
        status,
        toolRuns: [
          runtime.createToolRunResult(
            "bats",
            args,
            outcome.durationMs,
            outcome.exitCode,
            status,
            outcome.finishedAt,
            outcome.startedAt,
          ),
        ],
      };
    }

    const kcovCommand = await runtime.resolveBinaryIfAvailable(
      process.platform === "win32" ? ["kcov.exe", "kcov"] : ["kcov"],
    );
    if (kcovCommand === undefined) {
      return createBashTestSetupFailure(
        project,
        "kcov",
        `kcov is required for Bash coverage and was not detected in ${project.projectRoot}. Install kcov or disable Bash coverage.`,
        runtime,
      );
    }

    const coverageDirectory = path.join(tempDir, "kcov");
    const args = [
      "--clean",
      `--include-path=${project.projectRoot}`,
      coverageDirectory,
      batsCommand,
      "--report-formatter",
      "junit",
      "--output",
      tempDir,
      ...relativeTestFiles,
    ];
    const outcome = await runtime.runExecutable(
      kcovCommand,
      args,
      project.projectRoot,
      runtime.signal,
    );

    if (runtime.isMissingCommandOutcome(outcome.stderr, outcome.stdout, outcome.exitCode)) {
      return createBashTestSetupFailure(
        project,
        "kcov",
        `kcov is required for Bash coverage and could not be executed in ${project.projectRoot}. Install kcov or disable Bash coverage.`,
        runtime,
        {
          args,
          durationMs: outcome.durationMs,
          exitCode: outcome.exitCode,
          finishedAt: outcome.finishedAt,
          startedAt: outcome.startedAt,
        },
      );
    }

    const report = await parsers.parseJvmJunitReports(
      [junitPath],
      testFiles[0] ?? project.projectRoot,
      readOptionalTextFile,
    );
    const diagnostics: Diagnostic[] = report.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      source: "bats",
    }));
    const coverageReportPath =
      (await runtime.findFirstFile(
        coverageDirectory,
        (filePath) => path.basename(filePath).toLowerCase() === "cobertura.xml",
      )) ?? path.join(coverageDirectory, "cobertura.xml");
    const coveragePercent = parsers.readCoberturaLineRate(
      await readOptionalTextFile(coverageReportPath),
    );
    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    if (status === "failed" && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          testFiles[0] ?? project.projectRoot,
          "kcov",
          runtime.readProcessFailureMessage(
            "kcov",
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
      note: readBashCoverageNote(report.summary, coveragePercent),
      status,
      toolRuns: [
        runtime.createToolRunResult(
          "kcov",
          args,
          outcome.durationMs,
          outcome.exitCode,
          status,
          outcome.finishedAt,
          outcome.startedAt,
        ),
      ],
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function createBashTestSetupFailure(
  project: ScriptProject,
  tool: "bats" | "kcov",
  message: string,
  runtime: BashRunnerRuntime,
  toolRun?: {
    args: string[];
    durationMs: number;
    exitCode: number | undefined;
    finishedAt?: string;
    startedAt?: string;
  },
): {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  status: StageResult["status"];
  toolRuns: ToolRunResult[];
} {
  const file = project.files[0] ?? project.projectRoot;
  const args = toolRun?.args ?? [];
  const durationMs = toolRun?.durationMs ?? 0;

  return {
    diagnostics: [
      {
        file,
        message,
        severity: "error",
        source: tool,
      },
    ],
    durationMs,
    note: message,
    status: "failed",
    toolRuns: [
      runtime.createToolRunResult(
        tool,
        args,
        durationMs,
        toolRun?.exitCode,
        "failed",
        toolRun?.finishedAt,
        toolRun?.startedAt,
      ),
    ],
  };
}

export function summarizeProjectStageStatus(
  statuses: readonly StageResult["status"][],
): StageResult["status"] {
  if (statuses.length === 0) {
    return "passed";
  }

  if (statuses.includes("failed")) {
    return "failed";
  }

  if (statuses.includes("not_implemented")) {
    return "not_implemented";
  }

  return "passed";
}

function readBashUnitNote(summary: { failed: number; passed: number; total: number }): string {
  if (summary.total === 0) {
    return "Bats found no tests.";
  }

  return `Bats ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

function readBashCoverageNote(
  summary: { failed: number; passed: number; total: number },
  coveragePercent: number | undefined,
): string {
  if (summary.total === 0) {
    return "Bats found no tests.";
  }

  if (coveragePercent === undefined) {
    return `Bash coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }

  return `Bash coverage lines: ${coveragePercent.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
