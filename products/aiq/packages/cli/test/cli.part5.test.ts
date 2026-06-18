import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdtemp,
  os,
  path,
  readFile,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("shows help for operational guidance commands without requiring subcommands", async () => {
    for (const command of ["doctor", "setup", "hook", "ci", "ignore"]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(["node", "aiq", command, "--help"], {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("AIQ CLI");
      expect(stdout.value).toContain(`aiq ${command}`);
    }
  });

  it("accepts npm exec separators before the actual CLI command", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--", "--help"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Usage:");
  });

  it("prints first-run setup guidance when no supported project can be inferred", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-first-run-empty-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ first run");
    expect(stdout.value).toContain("No supported project marker was found");
    expect(stdout.value).toContain("aiq run <files...>");
    expect(stdout.value).toContain("package.json");
  });

  it("runs no-arg first-run from an inferred project and initializes config state", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-typescript-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ first run");
    expect(stdout.value).toContain("Detected project: TypeScript (tsconfig.json)");
    expect(stdout.value).toContain("Target: .");
    expect(stdout.value).toContain("Stages: lint");
    expect(stdout.value).toContain("Change stage: aiq config --set-stage <0-9>");
    expect(stdout.value).toContain("Prepare missing tools/config: aiq setup");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Stages: 1 lint passed");
    expect(stdout.value).toContain("Next: no action required.");

    const config = JSON.parse(
      await readFile(path.join(project.root, ".aiq", "aiq.config.json"), "utf8"),
    ) as { version: number };
    const progress = JSON.parse(
      await readFile(path.join(project.root, ".aiq", "progress.json"), "utf8"),
    ) as { current_stage: number; disabled: number[]; last_run: string | null; order: number[] };
    expect(config).toEqual({ version: 1 });
    expect(progress).toEqual({
      current_stage: 1,
      disabled: [],
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      last_run: null,
    });

    const statusStdout = new MemoryOutput();
    const statusStderr = new MemoryOutput();
    const statusExitCode = await runCli(["node", "aiq", "status", "--format", "json"], {
      cwd: project.root,
      stderr: statusStderr,
      stdin: new MemoryInput(),
      stdout: statusStdout,
    });

    expect(statusExitCode).toBe(0);
    expect(statusStderr.value).toBe("");
    const status = JSON.parse(statusStdout.value) as {
      artifactPaths: { plan: string; report: string };
      currentStage: { id: string; index: number; name: string };
      defaultRun: { range: string; stages: Array<{ id: string }> };
      lastRun: { status: string };
      nextCommand: string;
      selectedStages: string[];
    };
    expect(status.currentStage).toEqual({ id: "lint", index: 1, name: "lint" });
    expect(status.defaultRun.range).toBe("0..1");
    expect(status.defaultRun.stages.map((stage) => stage.id)).toEqual(["e2e", "lint"]);
    expect(status.selectedStages).toEqual(["e2e", "lint"]);
    expect(status.lastRun.status).toBe("passed");
    expect(status.nextCommand).toBe("aiq config --set-stage 2");
    expect(status.artifactPaths.report).toBe(
      path.join(project.root, ".aiq", "out", "aiq.report.json"),
    );
  });
});
