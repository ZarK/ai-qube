import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import type { LizardMetricsFileMetrics } from "../parsers/lizard.js";
import * as commands from "../tools/command-builders.js";
import { pathExists } from "../utils/path-utils.js";
import type { RustRunnerRuntime } from "./contracts.js";
import type { RustProject } from "./rust.js";

export type RustMetricsFileMetrics = LizardMetricsFileMetrics;

export type RustMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, RustMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function resolveRustBinary(runtime: RustRunnerRuntime): Promise<string> {
  return (
    (await runtime.resolveInstalledBinary("cargo")) ??
    (process.platform === "win32" ? "cargo.exe" : "cargo")
  );
}

export async function resolveRustProjectSourceFiles(
  project: RustProject,
  runtime: RustRunnerRuntime,
): Promise<string[]> {
  const selectedSourceFiles = project.files.filter((file) => file.toLowerCase().endsWith(".rs"));
  if (selectedSourceFiles.length > 0) {
    return [...new Set(selectedSourceFiles)].sort((left, right) => left.localeCompare(right));
  }

  return runtime.findMatchingFiles(
    project.projectRoot,
    (filePath) => filePath.toLowerCase().endsWith(".rs"),
    (directoryPath) => {
      const name = path.basename(directoryPath).toLowerCase();
      return name === ".git" || name === "target";
    },
  );
}

export async function getRustMetricsProjectMetrics(
  project: RustProject & { files: string[] },
  runtime: RustRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: RustMetricsProjectMetrics }> {
  const manifestKey = createRustMetricsManifestKey(project);
  const cacheKey = await createRustMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:rust", manifestKey, cacheKey, () =>
    runRustMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

export function parseCargoJsonDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  return parsers.parseCargoJsonDiagnostics(output, cwd, source);
}

export function parseRustFormatDiagnostics(output: string, cwd: string): Diagnostic[] {
  return parsers.parseRustFormatDiagnostics(output, cwd);
}

export function parseRustTestReport(
  output: string,
  cwd: string,
  source: string,
  fallbackFile: string,
): {
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
} {
  return parsers.parseRustTestReport(output, cwd, source, fallbackFile);
}

export function isMissingCargoSubcommand(output: string, subcommand: string): boolean {
  return parsers.isMissingCargoSubcommand(output, subcommand);
}

export function readLcovLineRate(reportContents: string | undefined): number | undefined {
  return parsers.readLcovLineRate(reportContents);
}

export function readRustUnitNote(summary: {
  failed: number;
  passed: number;
  total: number;
}): string {
  if (summary.total === 0) {
    return "cargo test found no tests.";
  }

  return `cargo test ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readRustCoverageNote(
  coveragePercent: number | undefined,
  summary: { failed: number; passed: number; total: number },
): string {
  if (summary.total === 0) {
    return "cargo llvm-cov found no tests.";
  }

  if (coveragePercent === undefined) {
    return `cargo llvm-cov completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }

  return `cargo llvm-cov lines: ${coveragePercent.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

export function createUnsupportedRustRunnerNote(stageId: string, files: readonly string[]): string {
  if (files.length === 0) {
    return `No Cargo manifest was detected for ${stageId}.`;
  }

  return `No Cargo manifest was detected for ${stageId} in: ${files.join(", ")}.`;
}

function createRustMetricsManifestKey(project: { files: string[]; manifestPath: string }): string {
  return `${project.manifestPath}:${[...project.files].sort().join("|")}`;
}

async function createRustMetricsCacheKey(
  project: { files: string[]; manifestPath: string },
  manifestKey = createRustMetricsManifestKey(project),
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

async function runRustMetricsProjectTask(
  project: RustProject & { files: string[] },
  runtime: RustRunnerRuntime,
): Promise<RustMetricsProjectMetrics> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-rust-metrics-"));

  try {
    const inputFile = path.join(tempDir, "files.txt");
    await writeFile(inputFile, `${project.files.join("\n")}\n`, "utf8");
    const args = commands.createLizardArgs({ inputFile, languages: ["rust"] });
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
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function readOptionalTextFile(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
