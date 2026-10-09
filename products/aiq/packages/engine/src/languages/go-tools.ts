import { stat } from "node:fs/promises";
import path from "node:path";

import type { Diagnostic } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import type { LizardMetricsFileMetrics } from "../parsers/lizard.js";
import * as commands from "../tools/command-builders.js";
import type { GoRunnerRuntime } from "./contracts.js";
import type { GoProject } from "./go.js";

export type GoMetricsFileMetrics = LizardMetricsFileMetrics;

export type GoMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, GoMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function resolveGoBinary(
  commandName: "go" | "gofmt",
  runtime: GoRunnerRuntime,
): Promise<string> {
  return (
    (await runtime.resolveInstalledBinary(commandName)) ??
    (process.platform === "win32" ? `${commandName}.exe` : commandName)
  );
}

export async function resolveGoProjectSourceFiles(
  project: GoProject,
  runtime: GoRunnerRuntime,
): Promise<string[]> {
  const selectedSourceFiles = project.files.filter((file) => file.toLowerCase().endsWith(".go"));
  if (selectedSourceFiles.length > 0) {
    return [...new Set(selectedSourceFiles)].sort((left, right) => left.localeCompare(right));
  }

  return runtime.findMatchingFiles(
    project.projectRoot,
    (filePath) => filePath.toLowerCase().endsWith(".go"),
    (directoryPath) => {
      const name = path.basename(directoryPath).toLowerCase();
      return name === ".git" || name === "vendor";
    },
  );
}

export async function getGoMetricsProjectMetrics(
  project: GoProject & { files: string[] },
  runtime: GoRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: GoMetricsProjectMetrics }> {
  const manifestKey = createGoMetricsManifestKey(project);
  const cacheKey = await createGoMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:go", manifestKey, cacheKey, () =>
    runGoMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

export function parseGoVetDiagnostics(stderr: string, stdout: string, cwd: string): Diagnostic[] {
  return parsers.parseGoVetDiagnostics(stderr, stdout, cwd);
}

export function parseGoCompilerDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  return parsers.parseGoCompilerDiagnostics(output, cwd, source);
}

export function parseGoFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  return parsers.parseGoFormatDiagnostics(output, cwd);
}

export function parseGoTestReport(
  output: string,
  cwd: string,
  source: string,
  fallbackFile: string,
): {
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
} {
  return parsers.parseGoTestReport(output, cwd, source, fallbackFile);
}

export function parseGoCoveragePercent(output: string): number | undefined {
  return parsers.parseGoCoveragePercent(output);
}

export function createUnsupportedGoRunnerNote(stageId: string, files: readonly string[]): string {
  if (files.length === 0) {
    return `No Go module was detected for ${stageId}.`;
  }

  return `No Go module was detected for ${stageId} in: ${files.join(", ")}.`;
}

export function readGoUnitNote(summary: {
  failed: number;
  passed: number;
  total: number;
}): string {
  if (summary.total === 0) {
    return "go test found no tests.";
  }

  return `go test ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readGoCoverageNote(
  coveragePercent: number | undefined,
  summary: { failed: number; passed: number; total: number },
): string {
  if (summary.total === 0) {
    return "go test found no tests.";
  }

  if (coveragePercent === undefined) {
    return `go test coverage completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }

  return `go test coverage lines: ${coveragePercent.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

function createGoMetricsManifestKey(project: { files: string[]; moduleFilePath: string }): string {
  return `${project.moduleFilePath}:${[...project.files].sort().join("|")}`;
}

async function createGoMetricsCacheKey(
  project: { files: string[]; moduleFilePath: string },
  manifestKey = createGoMetricsManifestKey(project),
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

async function runGoMetricsProjectTask(
  project: GoProject & { files: string[] },
  runtime: GoRunnerRuntime,
): Promise<GoMetricsProjectMetrics> {
  const tempDir = await (await import("node:fs/promises")).mkdtemp(
    path.join((await import("node:os")).tmpdir(), "aiq-go-metrics-"),
  );

  try {
    const inputFile = path.join(tempDir, "files.txt");
    await (await import("node:fs/promises")).writeFile(
      inputFile,
      `${project.files.join("\n")}\n`,
      "utf8",
    );
    const args = commands.createLizardArgs({ inputFile, languages: ["go"] });
    const outcome = await runtime.runExecutable(
      runtime.resolveUvxCommand(),
      args,
      project.projectRoot,
      runtime.signal,
    );
    if (outcome.exitCode !== 0) {
      throw new Error(
        runtime.readProcessFailureMessage(
          "lizard",
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      );
    }

    return {
      args,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      files: await parsers.parseLizardMetrics(outcome.stdout, project.projectRoot, project.files),
      finishedAt: outcome.finishedAt,
      startedAt: outcome.startedAt,
    };
  } finally {
    await (await import("node:fs/promises"))
      .rm(tempDir, { force: true, recursive: true })
      .catch(() => undefined);
  }
}
