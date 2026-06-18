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
  it("uses persisted current_stage for MCP run, plan, and status defaults", async () => {
    const repoDir = await createWorkspace("const ok = 1;\nexport { ok };\n");
    await writeFile(
      path.join(repoDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const adapter = new AiqMcpAdapter({
      cwd: repoDir,
      runEngineImpl: async (request) => createMcpProgressReport(repoDir, request),
    });

    const check = await adapter.check({ files: ["index.ts"] });
    const blankOverrideCheck = await adapter.check({
      files: ["index.ts"],
      profile: " ",
      stages: [" "],
    });
    const plan = await adapter.plan({ files: ["index.ts"] });
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

  it("rejects explain requests that provide neither files nor reportPath", async () => {
    const repoDir = await createWorkspace("const ok = 1;\nexport { ok };\n");
    const adapter = new AiqMcpAdapter({ cwd: repoDir, stages: ["lint"] });

    expect(aiqExplainDiagnosticsInputSchema.safeParse({}).success).toBe(false);
    expect(aiqExplainDiagnosticsInputSchema.safeParse({ reportPath: "   " }).success).toBe(false);
    await expect(adapter.explain({})).rejects.toThrowError("Provide files or reportPath.");
  });

  it("treats blank reportPath as absent when files are provided", async () => {
    const repoDir = await createWorkspace("var failing = 1;\nexport { failing };\n");
    const adapter = new AiqMcpAdapter({ cwd: repoDir, stages: ["lint"] });

    const explanation = await adapter.explain({
      files: ["index.ts"],
      reportPath: "   ",
    });

    expect(explanation.diagnosticCount).toBeGreaterThan(0);
    expect(explanation.text).toContain("AIQ diagnostics:");
  });

  it("wraps report artifact read failures with the resolved path", async () => {
    const repoDir = await createWorkspace("const ok = 1;\nexport { ok };\n");
    const adapter = new AiqMcpAdapter({ cwd: repoDir, stages: ["lint"] });
    const reportPath = "missing-report.json";

    await expect(adapter.explain({ reportPath })).rejects.toMatchObject({
      message: expect.stringContaining(
        `Failed to read AIQ report artifact at ${path.join(repoDir, reportPath)}:`,
      ),
    });
  });
});

function createMcpProgressReport(
  repoDir: string,
  request: { profile?: "fast"; stages?: readonly StageId[] },
): RunResult {
  const stages = [...(request.stages ?? [])];
  const profile = request.profile ?? "fast";
  const outDir = path.join(repoDir, ".aiq", "out");

  return {
    artifactType: "report",
    artifactVersion: 1,
    artifacts: { outDir },
    context: "mcp",
    durationMs: 1,
    engineVersion: "0.0.0",
    finishedAt: "2026-03-23T00:00:00.000Z",
    mode: "check",
    ok: true,
    stages: [],
    plan: createMcpProgressPlan(repoDir, outDir, stages, profile),
    request: createMcpProgressRequest(repoDir, outDir, stages, profile),
    runId: "run_123",
    startedAt: "2026-03-23T00:00:00.000Z",
    summary: createProgressSummary(stages.length),
  };
}

function createMcpProgressPlan(
  repoDir: string,
  outDir: string,
  stages: readonly StageId[],
  profile: "fast",
): RunResult["plan"] {
  return {
    artifactType: "plan",
    artifactVersion: 1,
    artifacts: { outDir },
    context: "mcp",
    createdAt: "2026-03-23T00:00:00.000Z",
    engineVersion: "0.0.0",
    input: {
      entries: [],
      files: [],
      root: repoDir,
      source: "direct",
      summary: { fileCount: 1 },
    },
    stages: [...stages],
    profile,
    runId: "run_123",
    summary: { fileCount: 1, stageCount: stages.length, taskCount: 0 },
    tasks: [],
  };
}

function createMcpProgressRequest(
  repoDir: string,
  outDir: string,
  stages: readonly StageId[],
  profile: "fast",
): RunResult["request"] {
  return {
    context: "mcp",
    cwd: repoDir,
    manifest: {
      entries: [],
      files: [],
      root: repoDir,
      source: "direct",
      summary: { fileCount: 1 },
    },
    mode: "check",
    outDir,
    selection: { stages: [...stages], profile },
    writeArtifacts: false,
  };
}

function createProgressSummary(stageCount: number): RunResult["summary"] {
  return {
    cacheHitCount: 0,
    cacheHitRate: 0,
    cacheMissCount: 0,
    diagnosticCount: 0,
    durationMs: 1,
    fileCount: 1,
    notImplementedStageCount: 0,
    stageCount,
    status: "passed",
    taskCount: 0,
    toolDurationMs: 0,
    toolRunCount: 0,
  };
}

async function createWorkspace(contents: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mcp-"));
  tempDirs.push(repoDir);

  await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
  const filePath = path.join(repoDir, "index.ts");
  await writeFile(filePath, contents, "utf8");
  await readFile(filePath, "utf8");

  return repoDir;
}
