import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunResult, StageId } from "../../model/src/index.js";

import {
  AiqOpenCodeAdapter,
  buildAiqOpenCodeHooks,
  formatAiqOpenCodeResult,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("OpenCode adapter", () => {
  it("runs AIQ on explicit files with read-only defaults", async () => {
    const repoDir = await createWorkspace({
      "src/index.ts": "var failing = 1;\nexport { failing };\n",
    });

    const adapter = new AiqOpenCodeAdapter({
      cwd: repoDir,
      stages: ["lint"],
    });
    const result = await adapter.run({
      files: ["src/index.ts"],
    });

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([path.join(repoDir, "src/index.ts")]);
    expect(result.report.context).toBe("opencode");
    expect(result.report.request.context).toBe("opencode");
    expect(result.publishDiagnostics).toBe(true);
    expect(result.diagnostics).not.toHaveLength(0);
    expect(result.planPath).toBeUndefined();
    expect(result.reportPath).toBeUndefined();
    expect(result.text).toContain("AIQ check");
  });

  it("hides diagnostics in the tool-facing result when opencode publishDiagnostics is disabled", async () => {
    const repoDir = await createWorkspace({
      "src/index.ts": "var failing = 1;\nexport { failing };\n",
    });

    const adapter = new AiqOpenCodeAdapter({
      cwd: repoDir,
      stages: ["lint"],
      resolveConfigImpl: async () => ({
        cadenceStages: [],
        changedOnly: true,
        config: defaultConfig,
        cwd: repoDir,
        stages: ["lint"],
        stageConfigurations: {
          lint: {
            languages: {
              typescript: {
                toolId: "biome",
              },
            },
          },
        },
        profile: "fast",
        publishDiagnostics: false,
        source: "defaults",
        surface: "opencode",
      }),
      writeArtifacts: false,
    });

    const result = await adapter.run({ files: ["src/index.ts"] });

    expect(result.publishDiagnostics).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.text).toContain("Diagnostics are hidden");
  });

  it("builds OpenCode hooks with the expected aiq_check_files tool", async () => {
    const hooks = await buildAiqOpenCodeHooks({
      directory: "/tmp/project",
    });

    expect(hooks).toHaveProperty("tool.aiq_check_files");
    expect(hooks).toHaveProperty("tool.aiq_plan_files");
    expect(hooks).toHaveProperty("tool.aiq_status");
    expect(hooks).toHaveProperty("tool.aiq_doctor");
  });

  it("uses persisted current_stage for OpenCode run, plan, and status defaults", async () => {
    const repoDir = await createWorkspace({
      "src/index.ts": "const ok = 1;\nexport { ok };\n",
    });
    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const adapter = new AiqOpenCodeAdapter({
      cwd: repoDir,
      runEngineImpl: async (request) => ({
        artifactType: "report",
        artifactVersion: 1,
        artifacts: { outDir: path.join(repoDir, ".aiq", "out") },
        context: "opencode",
        durationMs: 1,
        engineVersion: "0.0.0",
        finishedAt: "2026-03-23T00:00:00.000Z",
        mode: "check",
        ok: true,
        stages: [],
        plan: {
          artifactType: "plan",
          artifactVersion: 1,
          artifacts: { outDir: path.join(repoDir, ".aiq", "out") },
          context: "opencode",
          createdAt: "2026-03-23T00:00:00.000Z",
          engineVersion: "0.0.0",
          input: {
            entries: [],
            files: [],
            root: repoDir,
            source: "direct",
            summary: { fileCount: 1 },
          },
          stages: [...(request.stages ?? [])],
          profile: request.profile ?? "fast",
          runId: "run_123",
          summary: { fileCount: 1, stageCount: request.stages?.length ?? 0, taskCount: 0 },
          tasks: [],
        },
        request: {
          context: "opencode",
          cwd: repoDir,
          manifest: {
            entries: [],
            files: [],
            root: repoDir,
            source: "direct",
            summary: { fileCount: 1 },
          },
          mode: "check",
          outDir: path.join(repoDir, ".aiq", "out"),
          selection: { stages: [...(request.stages ?? [])], profile: request.profile ?? "fast" },
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
          fileCount: 1,
          notImplementedStageCount: 0,
          stageCount: request.stages?.length ?? 0,
          status: "passed",
          taskCount: 0,
          toolDurationMs: 0,
          toolRunCount: 0,
        },
      }),
    });

    const check = await adapter.run({ files: ["src/index.ts"] });
    const blankOverrideCheck = await adapter.run({
      files: ["src/index.ts"],
      profile: " ",
      stages: [" "],
    });
    const plan = await adapter.plan({ files: ["src/index.ts"] });
    const status = await adapter.status();

    expect(check.report.request.selection.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(blankOverrideCheck.report.request.selection.stages).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
    ]);
    expect(plan.plan.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(status.workflow).toMatchObject({
      currentStage: { id: "typecheck", index: 3 },
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
  });

  it("rejects empty file lists in the OpenCode tool schema", async () => {
    const hooks = await buildAiqOpenCodeHooks({
      directory: "/tmp/project",
    });
    const aiqCheckFiles = hooks.tool?.aiq_check_files;

    expect(aiqCheckFiles).toBeDefined();
    if (aiqCheckFiles === undefined) {
      throw new Error("Expected aiq_check_files tool.");
    }

    expect(safeParseToolSchema(aiqCheckFiles.args.files, []).success).toBe(false);
    expect(safeParseToolSchema(aiqCheckFiles.args.files, ["src/index.ts"]).success).toBe(true);
  });

  it("lets per-run stages and profile override adapter defaults", async () => {
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
    const adapter = new AiqOpenCodeAdapter({
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
          publishDiagnostics: true,
          source: "defaults",
          surface: "opencode",
        };
      },
      runEngineImpl: async (request): Promise<RunResult> => {
        const selectionStages: StageId[] = [...(request.stages ?? [])];
        forwardedStageConfigurations = request.stageConfigurations;

        return {
          artifactType: "report",
          artifactVersion: 1,
          artifacts: { outDir: "/tmp/out" },
          context: "opencode",
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
            context: "opencode",
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
            context: "opencode",
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

    await adapter.run({
      files: ["src/index.ts"],
      stages: ["typecheck"],
      profile: "deep",
    });

    expect(resolvedOptions).toEqual([{ stages: ["typecheck"], profile: "deep" }]);
    expect(forwardedStageConfigurations).toEqual(expectedStageConfigurations);
  });

  it("formats hidden diagnostics consistently", () => {
    expect(
      formatAiqOpenCodeResult(
        {
          artifactType: "report",
          artifactVersion: 1,
          artifacts: { outDir: "/tmp/out" },
          context: "opencode",
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
            context: "opencode",
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
            context: "opencode",
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
        },
        false,
      ),
    ).toContain("Diagnostics are hidden");
  });
});

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-opencode-"));
  tempDirs.push(repoDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }

  return repoDir;
}

function safeParseToolSchema(schema: unknown, value: unknown): { success: boolean } {
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("safeParse" in schema) ||
    typeof schema.safeParse !== "function"
  ) {
    throw new TypeError("Expected a tool schema with safeParse().");
  }

  return schema.safeParse(value) as { success: boolean };
}
