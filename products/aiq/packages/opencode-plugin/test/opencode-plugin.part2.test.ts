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
      runEngineImpl: async (request) => createOpenCodeProgressReport(repoDir, request),
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
});

function createOpenCodeProgressReport(
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
    context: "opencode",
    durationMs: 1,
    engineVersion: "0.0.0",
    finishedAt: "2026-03-23T00:00:00.000Z",
    mode: "check",
    ok: true,
    stages: [],
    plan: createOpenCodeProgressPlan(repoDir, outDir, stages, profile),
    request: createOpenCodeProgressRequest(repoDir, outDir, stages, profile),
    runId: "run_123",
    startedAt: "2026-03-23T00:00:00.000Z",
    summary: createProgressSummary(stages.length),
  };
}

function createOpenCodeProgressPlan(
  repoDir: string,
  outDir: string,
  stages: readonly StageId[],
  profile: "fast",
): RunResult["plan"] {
  return {
    artifactType: "plan",
    artifactVersion: 1,
    artifacts: { outDir },
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
    stages: [...stages],
    profile,
    runId: "run_123",
    summary: { fileCount: 1, stageCount: stages.length, taskCount: 0 },
    tasks: [],
  };
}

function createOpenCodeProgressRequest(
  repoDir: string,
  outDir: string,
  stages: readonly StageId[],
  profile: "fast",
): RunResult["request"] {
  return {
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
