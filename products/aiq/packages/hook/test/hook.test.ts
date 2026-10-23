import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PassThrough } from "node:stream";
import { installPreCommitHook } from "../../cli/src/hook-install.js";
import { runCli } from "../../cli/src/index.js";
import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunResult, StageId } from "../../model/src/index.js";
import { main, parseHookArgs } from "../src/bin/aiq-hook.js";
import { AiqHookCancelledError, renderPreCommitHookScript, runAiqHook } from "../src/index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("hook adapter", () => {
  it("supports standard root version forms", async () => {
    const packageJson = JSON.parse(
      await readFile(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as { name: string; version: string };
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(main(["node", "aiq-hook", "-v"])).resolves.toBe(0);
      expect(stdoutWrite).toHaveBeenLastCalledWith(`${packageJson.version}\n`);

      await expect(main(["node", "aiq-hook", "--version", "--json"])).resolves.toBe(0);
      expect(JSON.parse(String(stdoutWrite.mock.calls.at(-1)?.[0]))).toEqual({
        ok: true,
        command: "version",
        package: {
          name: packageJson.name,
          version: packageJson.version,
        },
        version: packageJson.version,
      });
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("runs AIQ on staged files and returns failing diagnostics", async () => {
    const repoDir = await createGitRepo({
      "src/index.ts": "var failing = 1;\nexport { failing };\n",
    });

    const result = await runAiqHook({ cwd: repoDir });

    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.stagedFiles).toEqual([path.join(repoDir, "src/index.ts")]);
    expect(result.result?.context).toBe("hook");
    expect(result.result?.request.context).toBe("hook");
    expect(result.result?.summary.diagnosticCount).toBeGreaterThan(0);
    expect(result.result?.artifacts.reportPath).toBeDefined();

    const reportPath = result.result?.artifacts.reportPath;
    if (reportPath === undefined) {
      throw new Error("Expected report artifact path for hook run.");
    }

    const reportJson = JSON.parse(await readFile(reportPath, "utf8")) as {
      artifactType: string;
      context: string;
    };
    expect(reportJson.artifactType).toBe("report");
    expect(reportJson.context).toBe("hook");
  });

  it("skips cleanly when nothing is staged", async () => {
    const repoDir = await createGitRepo();

    const result = await runAiqHook({ cwd: repoDir, writeArtifacts: false });

    expect(result).toEqual({
      exitCode: 0,
      ok: true,
      skipped: true,
      stagedFiles: [],
    });
  });

  it("only checks staged files and ignores unstaged tracked changes", async () => {
    const repoDir = await createCommittedGitRepo({
      "src/staged.ts": "const staged = 1;\nexport { staged };\n",
      "src/unstaged.ts": "const clean = 1;\nexport { clean };\n",
    });

    await writeFile(
      path.join(repoDir, "src", "staged.ts"),
      "var staged = 1;\nexport { staged };\n",
      "utf8",
    );
    await execFileAsync("git", ["add", "src/staged.ts"], { cwd: repoDir });
    await writeFile(
      path.join(repoDir, "src", "unstaged.ts"),
      "var unstaged = 2;\nexport { unstaged };\n",
      "utf8",
    );

    const result = await runAiqHook({ cwd: repoDir, writeArtifacts: false });

    expect(result.stagedFiles).toEqual([path.join(repoDir, "src", "staged.ts")]);
    expect(result.result?.request.manifest.files).toEqual([path.join(repoDir, "src", "staged.ts")]);
  });

  it("preserves staged filenames with leading whitespace", async () => {
    const repoDir = await createGitRepo({
      "src/ leading.ts": "const spaced = 1;\nexport { spaced };\n",
    });

    const result = await runAiqHook({
      cwd: repoDir,
      stages: ["lint"],
      writeArtifacts: false,
    });

    expect(result.stagedFiles).toEqual([path.join(repoDir, "src", " leading.ts")]);
    expect(result.result?.request.manifest.files).toEqual([
      path.join(repoDir, "src", " leading.ts"),
    ]);
  });

  it("uses persisted current_stage as the default cumulative hook target", async () => {
    const repoDir = await createGitRepo();
    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );

    const stagedFile = path.join(repoDir, "src", "index.ts");
    const result = await runAiqHook({
      cwd: repoDir,
      listStagedFilesImpl: async () => [stagedFile],
      runEngineImpl: async (request) => createHookProgressReport(repoDir, stagedFile, request),
      writeArtifacts: false,
    });

    expect(result.result?.request.selection.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(result.workflow).toMatchObject({
      currentStage: { id: "typecheck", index: 3 },
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
  });

  it("lets explicit hook stages override persisted current_stage", async () => {
    const repoDir = await createGitRepo();
    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const resolvedOptions: Array<readonly string[] | undefined> = [];

    const result = await runAiqHook({
      cwd: repoDir,
      listStagedFilesImpl: async () => [path.join(repoDir, "src", "index.ts")],
      resolveConfigImpl: async (options) => {
        resolvedOptions.push(options.stages);
        return {
          cadenceStages: [],
          changedOnly: true,
          config: defaultConfig,
          cwd: repoDir,
          stages: ["lint"],
          profile: "fast",
          publishDiagnostics: false,
          source: "defaults",
          surface: "hook",
        };
      },
      runEngineImpl: async () => ({
        artifactType: "report",
        artifactVersion: 1,
        artifacts: { outDir: path.join(repoDir, ".aiq", "out") },
        context: "hook",
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
          context: "hook",
          createdAt: "2026-03-23T00:00:00.000Z",
          engineVersion: "0.0.0",
          input: {
            entries: [],
            files: [],
            root: repoDir,
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
          context: "hook",
          cwd: repoDir,
          manifest: {
            entries: [],
            files: [],
            root: repoDir,
            source: "direct",
            summary: { fileCount: 0 },
          },
          mode: "check",
          outDir: path.join(repoDir, ".aiq", "out"),
          selection: { stages: ["lint"], profile: "fast" },
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
      stages: ["lint"],
      writeArtifacts: false,
    });

    expect(resolvedOptions).toEqual([["lint"]]);
    expect(result.workflow).toBeUndefined();
  });

  it("throws when the hook is cancelled before git diff runs", async () => {
    const repoDir = await createGitRepo();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAiqHook({
        cwd: repoDir,
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqHookCancelledError);
  });

  it("renders a pre-commit hook that invokes the absolute Quality entry point", () => {
    const entryPoint = path.resolve("Quality package", "aiq.js");
    const script = renderPreCommitHookScript(entryPoint);

    expect(script).toContain("#!/usr/bin/env sh");
    expect(script).toContain(entryPoint.replaceAll("\\", "/"));
    expect(script).toContain("hook run");
    expect(script).toContain("exec node");
  });

  it("installs into the effective hooks directory and preserves a different hook", async () => {
    const repoDir = await createGitRepo();
    await execFileAsync("git", ["config", "core.hooksPath", ".hooks"], {
      cwd: repoDir,
    });
    const entryPoint = fileURLToPath(new URL("../../cli/dist/bin/aiq.js", import.meta.url));
    let output = "";
    const exitCode = await runCli(["node", entryPoint, "hook", "install", "--format", "json"], {
      cwd: repoDir,
      stdin: new PassThrough(),
      stdout: {
        write: (text) => {
          output += text;
          return true;
        },
      },
      stderr: { write: () => true },
    });
    expect(exitCode).toBe(0);
    const { hookPath } = JSON.parse(output) as { hookPath: string };
    expect(hookPath).toBe(path.join(repoDir, ".hooks", "pre-commit"));
    expect(await readFile(hookPath, "utf8")).toBe(renderPreCommitHookScript(entryPoint));
    const nested = path.join(repoDir, "src");
    await mkdir(nested, { recursive: true });
    await expect(installPreCommitHook(nested, entryPoint)).resolves.toBe(hookPath);
    await writeFile(hookPath, "#!/bin/sh\necho custom\n");
    await expect(installPreCommitHook(repoDir, entryPoint)).rejects.toThrow(
      "different pre-commit hook",
    );
    expect(await readFile(hookPath, "utf8")).toContain("echo custom");
  });

  it("refuses an effective hooks directory outside the repository", async () => {
    const repoDir = await createGitRepo();
    const external = await mkdtemp(path.join(os.tmpdir(), "quality-hooks-"));
    tempDirs.push(external);
    await execFileAsync("git", ["config", "core.hooksPath", external], {
      cwd: repoDir,
    });
    await expect(installPreCommitHook(repoDir, fileURLToPath(import.meta.url))).rejects.toThrow(
      "outside the repository",
    );
  });

  it("runs configured staged checks through the published CLI and blocks failures", async () => {
    const repoDir = await createGitRepo({
      "src/index.ts": "var value = 1;\nexport { value };\n",
    });
    const configDir = path.join(repoDir, ".qube", "aiq");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "progress.json"),
      JSON.stringify({
        current_stage: 1,
        last_run: null,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        disabled: [],
      }),
    );
    let output = "";
    const exitCode = await runCli(["node", "aiq", "hook", "run", "--format", "json"], {
      cwd: repoDir,
      stdin: new PassThrough(),
      stdout: {
        write: (text) => {
          output += text;
          return true;
        },
      },
      stderr: { write: () => true },
    });
    expect(exitCode).toBe(1);
    const report = JSON.parse(output) as RunResult;
    expect(report.stages.map((stage) => stage.stageId)).toEqual(["e2e", "lint"]);
    expect(report.stages.find((stage) => stage.stageId === "lint")?.status).toBe("failed");
    const entryPoint = fileURLToPath(new URL("../../cli/dist/bin/aiq.js", import.meta.url));
    await installPreCommitHook(repoDir, entryPoint);
    await expect(
      execFileAsync("git", ["hook", "run", "pre-commit"], { cwd: repoDir }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Stage 1 (lint): FAILED"),
    });
  });

  it("rejects multiple hook stage selector flags", () => {
    expect(() => parseHookArgs(["--only", "1", "--stage", "lint"])).toThrowError(
      "Specify only one of --only, --up-to, or --stage.",
    );
  });
});

function createHookProgressReport(
  repoDir: string,
  stagedFile: string,
  request: { profile?: "fast"; stages?: readonly StageId[] },
): RunResult {
  const stages = [...(request.stages ?? [])];
  const profile = request.profile ?? "fast";
  const outDir = path.join(repoDir, ".aiq", "out");

  return {
    artifactType: "report",
    artifactVersion: 1,
    artifacts: { outDir },
    context: "hook",
    durationMs: 1,
    engineVersion: "0.0.0",
    finishedAt: "2026-03-23T00:00:00.000Z",
    mode: "check",
    ok: true,
    stages: [],
    plan: createHookProgressPlan(repoDir, stagedFile, outDir, stages, profile),
    request: createHookProgressRequest(repoDir, stagedFile, outDir, stages, profile),
    runId: "run_123",
    startedAt: "2026-03-23T00:00:00.000Z",
    summary: createProgressSummary(stages.length),
  };
}

function createHookProgressPlan(
  repoDir: string,
  stagedFile: string,
  outDir: string,
  stages: readonly StageId[],
  profile: "fast",
): RunResult["plan"] {
  return {
    artifactType: "plan",
    artifactVersion: 1,
    artifacts: { outDir },
    context: "hook",
    createdAt: "2026-03-23T00:00:00.000Z",
    engineVersion: "0.0.0",
    input: {
      entries: [],
      files: [stagedFile],
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

function createHookProgressRequest(
  repoDir: string,
  stagedFile: string,
  outDir: string,
  stages: readonly StageId[],
  profile: "fast",
): RunResult["request"] {
  return {
    context: "hook",
    cwd: repoDir,
    manifest: {
      entries: [],
      files: [stagedFile],
      root: repoDir,
      source: "direct",
      summary: { fileCount: 1 },
    },
    mode: "check",
    outDir,
    selection: {
      stages: [...stages],
      profile,
    },
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

async function createGitRepo(files: Record<string, string> = {}): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-hook-"));
  tempDirs.push(repoDir);

  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "core.hooksPath", ".git/hooks"], { cwd: repoDir });

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
    await execFileAsync("git", ["add", relativePath], { cwd: repoDir });
  }

  return repoDir;
}

async function createCommittedGitRepo(files: Record<string, string>): Promise<string> {
  const repoDir = await createGitRepo(files);
  await execFileAsync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=AIQ",
      "-c",
      "user.email=aiq@example.com",
      "commit",
      "-m",
      "init",
    ],
    { cwd: repoDir },
  );
  return repoDir;
}
