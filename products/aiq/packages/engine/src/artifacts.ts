import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunPlan, RunResult, RunTelemetryEvent } from "./contracts.js";

export const defaultOutDir = ".aiq/out";

export function resolveArtifactOutDir(root: string, outDir = defaultOutDir): string {
  return path.resolve(root, outDir);
}

export function resolvePlanArtifactPath(root: string, outDir = defaultOutDir): string {
  return path.join(resolveArtifactOutDir(root, outDir), "aiq.plan.json");
}

export function resolveReportArtifactPath(root: string, outDir = defaultOutDir): string {
  return path.join(resolveArtifactOutDir(root, outDir), "aiq.report.json");
}

export function resolveMetricsArtifactPath(root: string, outDir = defaultOutDir): string {
  return path.join(resolveArtifactOutDir(root, outDir), "aiq.metrics.jsonl");
}

export async function writePlanArtifact(plan: RunPlan, outDir = defaultOutDir): Promise<string> {
  const targetDir = resolveArtifactOutDir(plan.input.root, outDir);
  await mkdir(targetDir, { recursive: true });

  const filePath = resolvePlanArtifactPath(plan.input.root, outDir);
  await writeFile(filePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return filePath;
}

export async function writeReportArtifact(
  result: RunResult,
  outDir = defaultOutDir,
): Promise<string> {
  const targetDir = resolveArtifactOutDir(result.plan.input.root, outDir);
  await mkdir(targetDir, { recursive: true });

  const filePath = resolveReportArtifactPath(result.plan.input.root, outDir);
  const serializableResult: RunResult = {
    ...result,
    artifacts: {
      ...result.artifacts,
      reportPath: filePath,
    },
  };
  await writeFile(filePath, `${JSON.stringify(serializableResult, null, 2)}\n`, "utf8");

  return filePath;
}

export async function writeMetricsArtifact(
  events: readonly RunTelemetryEvent[],
  root: string,
  outDir = defaultOutDir,
): Promise<string> {
  const targetDir = resolveArtifactOutDir(root, outDir);
  await mkdir(targetDir, { recursive: true });

  const filePath = resolveMetricsArtifactPath(root, outDir);
  const contents = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(filePath, contents.length === 0 ? "" : `${contents}\n`, "utf8");

  return filePath;
}
