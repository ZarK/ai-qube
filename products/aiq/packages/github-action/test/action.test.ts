import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const githubActionPackageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const aiqRoot = path.join(githubActionPackageRoot, "..", "..");
const repoRoot = path.join(aiqRoot, "..", "..");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("github action adapter", () => {
  it("keeps the GitHub Action HTTP stack on patched undici", async () => {
    const githubActionPackageJson = JSON.parse(
      await readFile(path.join(githubActionPackageRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const aiqWorkspaceConfig = await readFile(path.join(aiqRoot, "pnpm-workspace.yaml"), "utf8");
    const rootWorkspaceConfig = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");

    expect(githubActionPackageJson.dependencies).toMatchObject({
      "@actions/artifact": "6.2.1",
      "@actions/core": "3.0.1",
    });
    expect(rootWorkspaceConfig).toMatch(/^overrides:\n {2}undici: 6\.27\.0$/m);
    expect(aiqWorkspaceConfig).toMatch(/^overrides:\n {2}undici: 6\.27\.0$/m);
    expect(rootWorkspaceConfig).toMatch(/^minimumReleaseAgeExclude:\n {2}- undici@6\.27\.0$/m);
    expect(aiqWorkspaceConfig).toMatch(/^ {2}- undici@6\.27\.0$/m);
    expect(rootWorkspaceConfig).not.toMatch(/^ {2}- undici$/m);
    expect(aiqWorkspaceConfig).not.toMatch(/^ {2}- undici$/m);

    for (const lockfilePath of [
      path.join(repoRoot, "pnpm-lock.yaml"),
      path.join(aiqRoot, "pnpm-lock.yaml"),
    ]) {
      const lockfile = await readFile(lockfilePath, "utf8");

      expect(lockfile).toContain("undici@6.27.0:");
      expect(lockfile).not.toMatch(/\bundici@(6\.25\.0|6\.26\.0):/);
      expect(lockfile).not.toMatch(/\bundici:\s*6\.(?:25|26)\.0/);
    }
  });

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
      rootDirectory: path.join(repoDir, ".qube", "aiq", "out"),
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
