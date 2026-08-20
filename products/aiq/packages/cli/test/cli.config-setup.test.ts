import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";

describe("AIQ config setup", () => {
  it("returns a JSON recovery action when stage selection is invalid", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-setup-error-"));
    tempDirs.push(repoDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "config", "--stages", "not-a-stage", "--format", "json"],
      { cwd: repoDir, stderr, stdin: new MemoryInput(), stdout },
    );

    expect(exitCode).toBe(2);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      ok: false,
      command: "config",
      error: expect.stringContaining("not-a-stage"),
      nextAction: expect.stringContaining("aiq schema --format json"),
    });
  });

  it("returns ordered stage metadata in a JSON dry-run without writing files", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-setup-json-"));
    tempDirs.push(repoDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "config",
        "--stages",
        "sloc,maintainability",
        "--dry-run",
        "--format",
        "json",
      ],
      {
        cwd: repoDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      command: string;
      ok: boolean;
      setup: {
        config: { operation: string; path: string };
        dryRun: boolean;
        progress: { operation: string; path: string };
        selection: { mode: string; requestedStages: string[]; resolvedStages: string[] };
        stageMetadata: Array<{
          description: string;
          id: string;
          index: number;
          refactorDriving: boolean;
          warning?: { code: string; message: string };
        }>;
      };
    };
    expect(output.ok).toBe(true);
    expect(output.command).toBe("config");
    expect(output.setup.dryRun).toBe(true);
    expect(output.setup.selection).toEqual({
      mode: "exact",
      requestedStages: ["sloc", "maintainability"],
      resolvedStages: ["sloc", "maintainability"],
    });
    expect(output.setup.stageMetadata.map((stage) => stage.id)).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
      "security",
    ]);
    const refactorStages = output.setup.stageMetadata.filter((stage) => stage.refactorDriving);
    expect(refactorStages.map((stage) => stage.id)).toEqual([
      "sloc",
      "complexity",
      "maintainability",
    ]);
    expect(refactorStages.every((stage) => stage.warning?.code === "robust-e2e-tests-recommended"))
      .toBe(true);
    expect(refactorStages[0]?.warning?.message).toContain("robust end-to-end tests");
    expect(
      output.setup.stageMetadata.find((stage) => stage.id === "maintainability")?.description,
    ).toContain("readability");
    await expect(access(output.setup.config.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(output.setup.progress.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the persisted exact stage set for default runtime selection", async () => {
    const project = await createTypeScriptFixtureProject("aiq-config-runtime-selection-");
    const configStdout = new MemoryOutput();
    const configStderr = new MemoryOutput();
    const configExitCode = await runCli(
      ["node", "aiq", "config", "--stages", "security,lint", "--format", "json"],
      {
        cwd: project.root,
        stderr: configStderr,
        stdin: new MemoryInput(),
        stdout: configStdout,
      },
    );
    const runStdout = new MemoryOutput();
    const runStderr = new MemoryOutput();
    const runExitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--dry-run", "--format", "json"],
      {
        cwd: project.root,
        stderr: runStderr,
        stdin: new MemoryInput(),
        stdout: runStdout,
      },
    );

    expect(configExitCode).toBe(0);
    expect(configStderr.value).toBe("");
    expect(runExitCode).toBe(0);
    expect(runStderr.value).toBe("");
    const setup = JSON.parse(configStdout.value) as {
      command: string;
      ok: boolean;
      setup: { selection: { mode: string; resolvedStages: string[] } };
    };
    const run = JSON.parse(runStdout.value) as { plan: { stages: string[] } };
    expect(setup).toMatchObject({ command: "config", ok: true });
    expect(setup.setup.selection).toMatchObject({
      mode: "exact",
      resolvedStages: ["lint", "security"],
    });
    expect(run.plan.stages).toEqual(["lint", "security"]);
  });
});
