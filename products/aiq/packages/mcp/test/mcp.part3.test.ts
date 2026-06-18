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
  it("lets per-call stages and profile override adapter defaults", async () => {
    const resolvedOptions: Array<{ stages?: readonly string[]; profile?: string }> = [];
    const expectedStageConfigurations = {
      typecheck: {
        languages: {
          typescript: {
            toolId: "typescript",
          },
        },
      },
    };
    let forwardedStageConfigurations: RunResult["request"]["selection"]["stageConfigurations"];
    const adapter = new AiqMcpAdapter({
      cwd: "/tmp/project",
      stages: ["lint"],
      profile: "fast",
      resolveConfigImpl: async (options) => {
        resolvedOptions.push({
          ...(options.stages === undefined ? {} : { stages: options.stages }),
          ...(options.profile === undefined ? {} : { profile: options.profile }),
        });

        return {
          cadenceStages: [],
          changedOnly: false,
          config: defaultConfig,
          cwd: "/tmp/project",
          stages: ["typecheck"],
          stageConfigurations: expectedStageConfigurations,
          profile: "deep",
          publishDiagnostics: false,
          source: "defaults",
          surface: "mcp",
        };
      },
      runEngineImpl: async (request): Promise<RunResult> => {
        const selectionStages: StageId[] = [...(request.stages ?? [])];
        forwardedStageConfigurations = request.stageConfigurations;

        return {
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
            profile: request.profile ?? "deep",
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
              stages: selectionStages,
              ...(request.stageConfigurations === undefined
                ? {}
                : { stageConfigurations: request.stageConfigurations }),
              profile: request.profile ?? "deep",
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
        };
      },
    });

    await adapter.check({
      files: ["index.ts"],
      stages: ["typecheck"],
      profile: "deep",
    });

    expect(resolvedOptions).toEqual([{ stages: ["typecheck"], profile: "deep" }]);
    expect(forwardedStageConfigurations).toEqual(expectedStageConfigurations);
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
