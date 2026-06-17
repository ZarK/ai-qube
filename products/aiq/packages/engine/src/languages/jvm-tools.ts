import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import type { LizardMetricsFileMetrics } from "../parsers/lizard.js";
import * as commands from "../tools/command-builders.js";
import type { JvmRunnerRuntime } from "./contracts.js";
import { type JvmBuildSystem, type JvmProject, jvmSourceExtensions } from "./jvm.js";

export type JvmCommand = {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv | undefined;
  label: string;
  tool: string;
};

export type JvmExecutable = {
  argsPrefix: string[];
  command: string;
  env: NodeJS.ProcessEnv | undefined;
};

export type JvmMetricsFileMetrics = LizardMetricsFileMetrics;

export type JvmMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, JvmMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function resolveJvmLintOrFormatCommand(
  project: JvmProject,
  mode: "format" | "lint",
  runtime: JvmRunnerRuntime,
): Promise<JvmCommand | undefined> {
  const buildFileContents = (await readFile(project.buildFilePath, "utf8")).toLowerCase();
  if (project.buildSystem === "maven") {
    const executable = await resolveMavenExecutable(project.projectRoot, runtime);
    if (buildFileContents.includes("spotless")) {
      return {
        args: [...executable.argsPrefix, "spotless:check"],
        command: executable.command,
        env: executable.env,
        label: "Maven Spotless",
        tool: "maven-spotless",
      };
    }
    if (mode === "lint" && buildFileContents.includes("checkstyle")) {
      return {
        args: [...executable.argsPrefix, "checkstyle:check"],
        command: executable.command,
        env: executable.env,
        label: "Maven Checkstyle",
        tool: "maven-checkstyle",
      };
    }
    if (buildFileContents.includes("ktlint")) {
      return {
        args: [...executable.argsPrefix, "ktlint:check"],
        command: executable.command,
        env: executable.env,
        label: "Maven ktlint",
        tool: "maven-ktlint",
      };
    }
    if (mode === "lint" && buildFileContents.includes("detekt")) {
      return {
        args: [...executable.argsPrefix, "detekt:check"],
        command: executable.command,
        env: executable.env,
        label: "Maven detekt",
        tool: "maven-detekt",
      };
    }
    return undefined;
  }

  const executable = await resolveGradleExecutable(project.projectRoot, runtime);
  if (buildFileContents.includes("spotless")) {
    return {
      args: [...executable.argsPrefix, "spotlessCheck"],
      command: executable.command,
      env: executable.env,
      label: "Gradle Spotless",
      tool: "gradle-spotless",
    };
  }
  if (mode === "lint" && buildFileContents.includes("checkstyle")) {
    return {
      args: [...executable.argsPrefix, "checkstyleMain"],
      command: executable.command,
      env: executable.env,
      label: "Gradle Checkstyle",
      tool: "gradle-checkstyle",
    };
  }
  if (buildFileContents.includes("ktlint")) {
    return {
      args: [...executable.argsPrefix, "ktlintCheck"],
      command: executable.command,
      env: executable.env,
      label: "Gradle ktlint",
      tool: "gradle-ktlint",
    };
  }
  if (mode === "lint" && buildFileContents.includes("detekt")) {
    return {
      args: [...executable.argsPrefix, "detekt"],
      command: executable.command,
      env: executable.env,
      label: "Gradle detekt",
      tool: "gradle-detekt",
    };
  }
  return undefined;
}

export async function resolveJvmExecutionCommand(
  project: JvmProject,
  mode: "coverage" | "typecheck" | "unit",
  tempDir: string,
  runtime: JvmRunnerRuntime,
): Promise<JvmCommand | undefined> {
  if (project.buildSystem === "maven") {
    const executable = await resolveMavenExecutable(project.projectRoot, runtime);
    if (mode === "typecheck") {
      return {
        args: [...executable.argsPrefix, "compile", "test-compile", "-DskipTests"],
        command: executable.command,
        env: executable.env,
        label: "Maven compile",
        tool: "maven-build",
      };
    }
    if (mode === "unit") {
      return {
        args: [...executable.argsPrefix, "test"],
        command: executable.command,
        env: executable.env,
        label: "Maven test",
        tool: "maven-test",
      };
    }
    return {
      args: [...executable.argsPrefix, "verify"],
      command: executable.command,
      env: executable.env,
      label: "Maven coverage",
      tool: "maven-test-coverage",
    };
  }

  const executable = await resolveGradleExecutable(project.projectRoot, runtime);
  if (mode === "typecheck") {
    return {
      args: [...executable.argsPrefix, "classes", "testClasses", "--console=plain", "--no-daemon"],
      command: executable.command,
      env: executable.env,
      label: "Gradle classes",
      tool: "gradle-build",
    };
  }
  if (mode === "unit") {
    return {
      args: [
        ...executable.argsPrefix,
        "test",
        "--console=plain",
        "--no-daemon",
        `--project-cache-dir=${path.join(tempDir, "project-cache")}`,
      ],
      command: executable.command,
      env: executable.env,
      label: "Gradle test",
      tool: "gradle-test",
    };
  }
  return {
    args: [
      ...executable.argsPrefix,
      "test",
      "jacocoTestReport",
      "--console=plain",
      "--no-daemon",
      `--project-cache-dir=${path.join(tempDir, "project-cache")}`,
    ],
    command: executable.command,
    env: executable.env,
    label: "Gradle coverage",
    tool: "gradle-test-coverage",
  };
}

export async function findJvmJunitReports(
  project: JvmProject,
  tempDir: string,
  runtime: JvmRunnerRuntime,
): Promise<string[]> {
  const patterns =
    project.buildSystem === "maven"
      ? [path.join(project.projectRoot, "target", "surefire-reports")]
      : [
          path.join(project.projectRoot, "build", "test-results", "test"),
          path.join(project.projectRoot, "build", "test-results"),
          tempDir,
        ];
  const matches = await Promise.all(
    patterns.map(async (directory) =>
      runtime.findMatchingFiles(
        directory,
        (filePath) => path.basename(filePath).startsWith("TEST-") && filePath.endsWith(".xml"),
      ),
    ),
  );
  return [...new Set(matches.flat())].sort((left, right) => left.localeCompare(right));
}

export async function findJvmCoverageReport(
  project: JvmProject,
  tempDir: string,
  runtime: JvmRunnerRuntime,
): Promise<string | undefined> {
  const candidates =
    project.buildSystem === "maven"
      ? [path.join(project.projectRoot, "target", "site", "jacoco", "jacoco.xml")]
      : [
          path.join(
            project.projectRoot,
            "build",
            "reports",
            "jacoco",
            "test",
            "jacocoTestReport.xml",
          ),
          path.join(
            project.projectRoot,
            "build",
            "reports",
            "jacoco",
            "jacocoTestReport",
            "jacocoTestReport.xml",
          ),
          tempDir,
        ];
  for (const candidate of candidates) {
    if (candidate.endsWith(".xml")) {
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch {
        continue;
      }
    }
    const report = await runtime.findFirstFile(
      candidate,
      (filePath) =>
        path.basename(filePath) === "jacoco.xml" ||
        path.basename(filePath) === "jacocoTestReport.xml",
    );
    if (report !== undefined) {
      return report;
    }
  }
  return undefined;
}

export async function resolveJvmMetricsFiles(
  project: JvmProject,
  runtime: JvmRunnerRuntime,
): Promise<string[]> {
  const selectedSourceFiles = project.files.filter((file) =>
    jvmSourceExtensions.has(path.extname(file).toLowerCase()),
  );
  if (selectedSourceFiles.length > 0) {
    return [...new Set(selectedSourceFiles)].sort((left, right) => left.localeCompare(right));
  }

  return runtime.findMatchingFiles(
    project.projectRoot,
    (filePath) => jvmSourceExtensions.has(path.extname(filePath).toLowerCase()),
    (directoryPath) => {
      const name = path.basename(directoryPath).toLowerCase();
      return name === ".gradle" || name === "build" || name === "out" || name === "target";
    },
  );
}

export async function getJvmMetricsProjectMetrics(
  project: JvmProject & { files: string[] },
  runtime: JvmRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: JvmMetricsProjectMetrics }> {
  const manifestKey = createJvmMetricsManifestKey(project);
  const cacheKey = await createJvmMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:jvm", manifestKey, cacheKey, () =>
    runJvmMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

export function parseJvmCompilerDiagnostics(
  output: string,
  cwd: string,
  source: string,
): Diagnostic[] {
  return parsers.parseJvmCompilerDiagnostics(output, cwd, source);
}

export function readJacocoLineRate(reportXml: string | undefined): number | undefined {
  return parsers.readJacocoLineRate(reportXml);
}

export function readJvmUnitNote(
  buildSystem: JvmBuildSystem,
  summary: { failed: number; passed: number; total: number },
): string {
  const label = buildSystem === "maven" ? "Maven test" : "Gradle test";
  if (summary.total === 0) {
    return `${label} found no tests.`;
  }
  return `${label} ran ${summary.total} test${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ${summary.failed} failed.`;
}

export function readJvmCoverageNote(
  buildSystem: JvmBuildSystem,
  summary: { failed: number; passed: number; total: number },
  coveragePercent: number | undefined,
): string {
  const label = buildSystem === "maven" ? "Maven coverage" : "Gradle coverage";
  if (summary.total === 0) {
    return `${label} found no tests.`;
  }
  if (coveragePercent === undefined) {
    return `${label} completed after ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
  }
  return `${label} lines: ${coveragePercent.toFixed(1)}% across ${summary.total} test${summary.total === 1 ? "" : "s"}.`;
}

export function createUnsupportedJvmRunnerNote(stageId: string, files: readonly string[]): string {
  if (files.length === 0) {
    return `No JVM build target was detected for ${stageId}.`;
  }
  return `No JVM build target was detected for ${stageId} in: ${files.join(", ")}.`;
}

async function resolveMavenExecutable(
  projectRoot: string,
  runtime: JvmRunnerRuntime,
): Promise<JvmExecutable> {
  const wrapperName = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
  const wrapperPath = path.join(projectRoot, wrapperName);
  try {
    await readFile(wrapperPath, "utf8");
    return { argsPrefix: [], command: wrapperPath, env: await runtime.createJvmProcessEnv() };
  } catch {
    return {
      argsPrefix: [],
      command: (await runtime.resolveInstalledBinary("mvn")) ?? runtime.resolveMavenCommand(),
      env: await runtime.createJvmProcessEnv(),
    };
  }
}

async function resolveGradleExecutable(
  projectRoot: string,
  runtime: JvmRunnerRuntime,
): Promise<JvmExecutable> {
  const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapperPath = path.join(projectRoot, wrapperName);
  try {
    await readFile(wrapperPath, "utf8");
    return { argsPrefix: [], command: wrapperPath, env: await runtime.createJvmProcessEnv() };
  } catch {
    return {
      argsPrefix: [],
      command: (await runtime.resolveInstalledBinary("gradle")) ?? runtime.resolveGradleCommand(),
      env: await runtime.createJvmProcessEnv(),
    };
  }
}

function createJvmMetricsManifestKey(project: { buildFilePath: string; files: string[] }): string {
  return `${project.buildFilePath}:${[...project.files].sort().join("|")}`;
}

async function createJvmMetricsCacheKey(
  project: { buildFilePath: string; files: string[] },
  manifestKey = createJvmMetricsManifestKey(project),
): Promise<string> {
  const fileEntries = await Promise.all(
    [...project.files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const fileStats = await (await import("node:fs/promises")).stat(file);
        return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
      }),
  );
  return `${manifestKey}:${fileEntries.join("|")}`;
}

async function runJvmMetricsProjectTask(
  project: JvmProject & { files: string[] },
  runtime: JvmRunnerRuntime,
): Promise<JvmMetricsProjectMetrics> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-jvm-metrics-"));

  try {
    const inputFile = path.join(tempDir, "files.txt");
    await writeFile(inputFile, `${project.files.join("\n")}\n`, "utf8");
    const args = commands.createLizardArgs({ inputFile, languages: ["java", "kotlin"] });
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
