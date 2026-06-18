import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunResult, StageId } from "../../model/src/index.js";

import {
  AiqMcpAdapter,
  aiqExplainDiagnosticsInputSchema,
  createAiqMcpServer,
  formatDiagnosticExplanation,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("MCP adapter", () => {
  it("formats empty diagnostic explanations", () => {
    expect(
      formatDiagnosticExplanation({
        artifactType: "report",
        artifactVersion: 1,
        artifacts: { outDir: "/tmp/out" },
        context: "mcp",
        durationMs: 1,
        engineVersion: "0.0.0",
        finishedAt: "2026-03-23T00:00:00.000Z",
        mode: "check",
        ok: true,
        stages: [],
        plan: {
          artifactType: "plan",
          artifactVersion: 1,
          artifacts: { outDir: "/tmp/out" },
          context: "mcp",
          createdAt: "2026-03-23T00:00:00.000Z",
          engineVersion: "0.0.0",
          input: {
            entries: [],
            files: [],
            root: "/tmp/project",
            source: "direct",
            summary: { fileCount: 0 },
          },
          stages: [],
          profile: "fast",
          runId: "run_123",
          summary: { fileCount: 0, stageCount: 0, taskCount: 0 },
          tasks: [],
        },
        request: {
          context: "mcp",
          cwd: "/tmp/project",
          manifest: {
            entries: [],
            files: [],
            root: "/tmp/project",
            source: "direct",
            summary: { fileCount: 0 },
          },
          mode: "check",
          outDir: "/tmp/out",
          selection: {
            stages: [],
            profile: "fast",
          },
          writeArtifacts: false,
        },
        runId: "run_123",
        startedAt: "2026-03-23T00:00:00.000Z",
        summary: {
          cacheHitCount: 0,
          cacheHitRate: 0,
          cacheMissCount: 0,
          diagnosticCount: 0,
          durationMs: 1,
          fileCount: 0,
          notImplementedStageCount: 0,
          stageCount: 0,
          status: "passed",
          taskCount: 0,
          toolDurationMs: 0,
          toolRunCount: 0,
        },
      }),
    ).toBe("AIQ found no diagnostics.");
  });
});

async function createWorkspace(contents: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mcp-"));
  tempDirs.push(repoDir);

  await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
  const filePath = path.join(repoDir, "index.ts");
  await writeFile(filePath, contents, "utf8");
  await readFile(filePath, "utf8");

  return repoDir;
}
