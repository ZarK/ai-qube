import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunResult } from "../../model/src/index.js";

import {
  type GitHubActionIo,
  parseGitHubActionStageInput,
  parsePositiveInteger,
  runAiqGitHubAction,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("github action adapter", () => {
  it("runs AIQ on tracked files, emits annotations, and uploads canonical artifacts", async () => {
    const repoDir = await createGitRepo({
      "src/index.ts": "var failing = 1;\nexport { failing };\n",
    });
    const io = new MemoryGitHubActionIo();

    const outcome = await runAiqGitHubAction(io, {
      artifactName: "aiq-artifact",
      cwd: repoDir,
      stages: ["lint"],
    });

    expect(outcome.skipped).toBe(false);
    expect(outcome.report?.context).toBe("github");
    expect(outcome.report?.request.context).toBe("github");
    expect(io.annotations).not.toHaveLength(0);
    expect(io.annotations[0]).toMatchObject({
      file: "src/index.ts",
      level: "error",
    });
    expect(io.failedMessages).toHaveLength(1);
    expect(io.outputs.get("status")).toBe("failed");
    expect(io.outputs.get("diagnostic-count")).toBeGreaterThan(0);
    expect(io.uploads).toHaveLength(1);
    expect(io.uploads[0]).toMatchObject({
      name: "aiq-artifact",
      rootDirectory: path.join(repoDir, ".aiq", "out"),
    });
    expect(io.uploads[0]?.files.map((file) => path.basename(file)).sort()).toEqual([
      "aiq.plan.json",
      "aiq.report.json",
    ]);

    const reportPath = outcome.report?.artifacts.reportPath;
    if (reportPath === undefined) {
      throw new Error("Expected a GitHub action report artifact path.");
    }

    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      artifactType: string;
      context: string;
    };
    expect(reportJson.artifactType).toBe("report");
    expect(reportJson.context).toBe("github");
  });

  it("publishes a passing run without failure messages", async () => {
    const repoDir = await createGitRepo({
      "src/index.ts": "const passing = 1;\nexport { passing };\n",
    });
    const io = new MemoryGitHubActionIo();

    const outcome = await runAiqGitHubAction(io, {
      cwd: repoDir,
      stages: ["lint"],
    });

    expect(outcome.report?.ok).toBe(true);
    expect(io.annotations).toEqual([]);
    expect(io.failedMessages).toEqual([]);
    expect(io.outputs.get("ok")).toBe(true);
    expect(io.outputs.get("status")).toBe("passed");
    expect(io.uploads).toHaveLength(1);
  });

  it("respects github publishDiagnostics=false while still uploading artifacts", async () => {
    const repoDir = await createGitRepo(
      {
        "src/index.ts": "var failing = 1;\nexport { failing };\n",
      },
      {
        version: 1,
        profiles: {
          fast: {
            changedOnly: false,
            stages: ["lint"],
          },
        },
        surfaces: {
          github: {
            profile: "fast",
            publishDiagnostics: false,
          },
        },
      },
    );
    const io = new MemoryGitHubActionIo();

    const outcome = await runAiqGitHubAction(io, { cwd: repoDir });

    expect(outcome.report?.ok).toBe(false);
    expect(io.annotations).toEqual([]);
    expect(io.failedMessages).toHaveLength(1);
    expect(io.uploads).toHaveLength(1);
  });

  it("uses persisted current_stage as the default cumulative GitHub Action target", async () => {
    const repoDir = await createGitRepo({
      "src/index.ts": "const value = 1;\nexport { value };\n",
    });
    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const outDir = path.join(repoDir, ".aiq", "out");
    await mkdir(outDir, { recursive: true });
    const reportPath = path.join(outDir, "aiq.report.json");
    const result = createRunResult({
      cwd: repoDir,
      diagnostics: [],
      outDir,
      reportPath,
      status: "passed",
    });
    await writeFile(reportPath, `${JSON.stringify(result)}\n`, "utf8");
    const resolvedStages: Array<readonly string[] | undefined> = [];
    const io = new MemoryGitHubActionIo();

    const outcome = await runAiqGitHubAction(
      io,
      { cwd: repoDir, files: ["src/index.ts"] },
      {
        resolveConfigImpl: async (options) => {
          resolvedStages.push(options.stages);
          return {
            cadenceStages: [],
            changedOnly: false,
            config: defaultConfig,
            cwd: repoDir,
            stages: [...(options.stages ?? [])],
            profile: "deep",
            publishDiagnostics: true,
            source: "defaults",
            surface: "github",
          };
        },
        runEngineImpl: async () => result,
      },
    );

    expect(resolvedStages).toEqual([["e2e", "lint", "format", "typecheck"]]);
    expect(outcome.workflow).toMatchObject({
      currentStage: { id: "typecheck", index: 3 },
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
    expect(io.outputs.get("current-stage")).toBe(3);
    expect(io.outputs.get("stages")).toBe("e2e,lint,format,typecheck");
  });

  it("parses and de-duplicates stage input", () => {
    expect(parseGitHubActionStageInput(["lint", "lint", "typecheck"])).toEqual([
      "lint",
      "typecheck",
    ]);
  });

  it("rejects malformed max-annotation input", () => {
    expect(parsePositiveInteger("5", "max-annotations")).toBe(5);
    expect(() => parsePositiveInteger("5.5", "max-annotations")).toThrowError(
      "max-annotations must be a non-negative integer.",
    );
    expect(() => parsePositiveInteger("5oops", "max-annotations")).toThrowError(
      "max-annotations must be a non-negative integer.",
    );
  });

  it("uses the canonical report artifact for annotations instead of the in-memory result", async () => {
    const repoDir = await createGitRepo({
      "src/index.ts": "const value = 1;\nexport { value };\n",
    });
    const outDir = path.join(repoDir, ".aiq", "out");
    await mkdir(outDir, { recursive: true });

    const planPath = path.join(outDir, "aiq.plan.json");
    const reportPath = path.join(outDir, "aiq.report.json");
    await writeFile(planPath, "{}\n", "utf8");

    const canonicalReport = createRunResult({
      cwd: repoDir,
      diagnostics: [
        {
          file: path.join(repoDir, "src/index.ts"),
          message: "Canonical artifact warning",
          severity: "warning",
          source: "aiq",
        },
      ],
      outDir,
      reportPath,
      status: "failed",
    });
    await writeFile(reportPath, `${JSON.stringify(canonicalReport, null, 2)}\n`, "utf8");

    const io = new MemoryGitHubActionIo();
    const inMemoryResult = createRunResult({
      cwd: repoDir,
      diagnostics: [],
      outDir,
      reportPath,
      status: "passed",
    });

    await runAiqGitHubAction(
      io,
      {
        cwd: repoDir,
        files: ["src/index.ts"],
      },
      {
        runEngineImpl: async () => inMemoryResult,
      },
    );

    expect(io.annotations).toEqual([
      {
        file: "src/index.ts",
        level: "warning",
        message: "Canonical artifact warning",
        title: "AIQ/aiq",
      },
    ]);
    expect(io.outputs.get("status")).toBe("failed");
    expect(io.uploads[0]?.rootDirectory).toBe(outDir);
  });

  it("keeps the action runtime path pointed at a bundled file", async () => {
    const actionYamlPath = path.resolve("packages/github-action/action.yml");
    const actionYaml = await readFile(actionYamlPath, "utf8");
    const mainMatch = /^\s*main:\s*(.+)$/mu.exec(actionYaml);
    const runtimePath = path.resolve(path.dirname(actionYamlPath), mainMatch?.[1] ?? "missing");

    expect(mainMatch?.[1]).toBe("dist/main.mjs");
    await expect(access(runtimePath)).resolves.toBeUndefined();

    const runtimeSource = await readFile(runtimePath, "utf8");
    const shebangLines = runtimeSource.split(/\r?\n/u).filter((line) => line.startsWith("#!"));
    expect(shebangLines).toEqual(["#!/usr/bin/env node"]);

    const repoDir = await createGitRepo({
      "src/index.ts": "const bundled = 1;\nexport { bundled };\n",
    });
    const result = await execFileAsync(process.execPath, [runtimePath], {
      cwd: repoDir,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: repoDir,
        INPUT_ANNOTATE: "false",
        INPUT_FILES: "src/index.ts",
        INPUT_STAGES: "lint",
        "INPUT_UPLOAD-ARTIFACT": "false",
      },
    });

    expect(result.stderr).not.toContain("Dynamic require");
    expect(result.stderr).not.toContain("SyntaxError");
    expect(result.stdout).toContain("AIQ check");
  });
});

class MemoryGitHubActionIo implements GitHubActionIo {
  readonly annotations: Array<{
    file?: string;
    level: string;
    message: string;
    title: string;
  }> = [];

  readonly failedMessages: string[] = [];

  readonly infoMessages: string[] = [];

  readonly outputs = new Map<string, boolean | number | string>();

  readonly uploads: Array<{
    files: string[];
    name: string;
    rootDirectory: string;
  }> = [];

  emitAnnotation(annotation: {
    file?: string;
    level: "error" | "notice" | "warning";
    message: string;
    title: string;
  }): void {
    this.annotations.push(annotation);
  }

  info(message: string): void {
    this.infoMessages.push(message);
  }

  setFailed(message: string): void {
    this.failedMessages.push(message);
  }

  setOutput(name: string, value: boolean | number | string): void {
    this.outputs.set(name, value);
  }

  async uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
  ): Promise<{ id: number; size: number }> {
    this.uploads.push({ files, name, rootDirectory });
    return {
      id: 1,
      size: files.length,
    };
  }
}

async function createGitRepo(
  files: Record<string, string>,
  config?: Record<string, unknown>,
): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-github-action-"));
  tempDirs.push(repoDir);

  await execFileAsync("git", ["init"], { cwd: repoDir });

  if (config !== undefined) {
    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "aiq.config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
    await execFileAsync("git", ["add", relativePath], { cwd: repoDir });
  }

  return repoDir;
}

function createRunResult(options: {
  cwd: string;
  diagnostics: Array<{
    file: string;
    message: string;
    severity: "error" | "info" | "warning";
    source: string;
  }>;
  outDir: string;
  reportPath: string;
  status: "failed" | "passed";
}): RunResult {
  const planPath = path.join(options.outDir, "aiq.plan.json");
  const result: RunResult = {
    artifactType: "report",
    artifactVersion: 1,
    artifacts: {
      outDir: options.outDir,
      planPath,
      reportPath: options.reportPath,
    },
    context: "github",
    durationMs: 1,
    engineVersion: "0.0.0",
    finishedAt: "2026-03-23T00:00:00.000Z",
    mode: "check",
    ok: options.status === "passed",
    stages: [
      {
        diagnostics: options.diagnostics,
        durationMs: 1,
        notes: [],
        stageId: "lint",
        status: options.status,
        toolRuns: [],
      },
    ],
    plan: {
      artifactType: "plan",
      artifactVersion: 1,
      artifacts: {
        outDir: options.outDir,
      },
      context: "github",
      createdAt: "2026-03-23T00:00:00.000Z",
      engineVersion: "0.0.0",
      input: {
        entries: [
          {
            extension: ".ts",
            path: path.join(options.cwd, "src/index.ts"),
          },
        ],
        files: [path.join(options.cwd, "src/index.ts")],
        root: options.cwd,
        source: "direct",
        summary: {
          fileCount: 1,
        },
      },
      stages: ["lint"],
      profile: "deep",
      runId: "run_123",
      summary: {
        fileCount: 1,
        stageCount: 1,
        taskCount: 1,
      },
      tasks: [
        {
          fileCount: 1,
          files: [path.join(options.cwd, "src/index.ts")],
          id: "task_123",
          stageId: "lint",
        },
      ],
    },
    request: {
      context: "github",
      cwd: options.cwd,
      manifest: {
        entries: [
          {
            extension: ".ts",
            path: path.join(options.cwd, "src/index.ts"),
          },
        ],
        files: [path.join(options.cwd, "src/index.ts")],
        root: options.cwd,
        source: "direct",
        summary: {
          fileCount: 1,
        },
      },
      mode: "check",
      outDir: options.outDir,
      selection: {
        stages: ["lint"],
        profile: "deep",
      },
      writeArtifacts: true,
    },
    runId: "run_123",
    startedAt: "2026-03-23T00:00:00.000Z",
    summary: {
      cacheHitCount: 0,
      cacheHitRate: 0,
      cacheMissCount: 0,
      diagnosticCount: options.diagnostics.length,
      durationMs: 1,
      fileCount: 1,
      notImplementedStageCount: 0,
      stageCount: 1,
      status: options.status,
      taskCount: 1,
      toolDurationMs: 0,
      toolRunCount: 0,
    },
  };

  return result;
}
