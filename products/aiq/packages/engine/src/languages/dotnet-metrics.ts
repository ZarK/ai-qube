import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type LizardMetricsFileMetrics, parseLizardMetrics } from "../parsers/lizard.js";
import { createLizardArgs } from "../tools/command-builders.js";

import type { DotNetRunnerRuntime } from "./contracts.js";
import type { DotNetProject } from "./dotnet.js";

export type DotNetMetricsFileMetrics = LizardMetricsFileMetrics;

export type DotNetMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, DotNetMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function getDotNetMetricsProjectMetrics(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: DotNetMetricsProjectMetrics }> {
  const manifestKey = createDotNetMetricsManifestKey(project);
  const cacheKey = await createDotNetMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:dotnet", manifestKey, cacheKey, () =>
    runDotNetMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

function createDotNetMetricsManifestKey(project: DotNetProject): string {
  return `${project.targetPath}:${[...project.files].sort().join("|")}`;
}

async function createDotNetMetricsCacheKey(
  project: DotNetProject,
  manifestKey = createDotNetMetricsManifestKey(project),
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

async function runDotNetMetricsProjectTask(
  project: DotNetProject,
  runtime: DotNetRunnerRuntime,
): Promise<DotNetMetricsProjectMetrics> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-dotnet-metrics-"));
  try {
    const inputFile = path.join(tempDir, "files.txt");
    await writeFile(inputFile, `${project.files.join("\n")}\n`, "utf8");
    const args = createLizardArgs({ inputFile, languages: ["csharp"] });
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
      files: await parseLizardMetrics(outcome.stdout, project.projectRoot, project.files),
      finishedAt: outcome.finishedAt,
      startedAt: outcome.startedAt,
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
