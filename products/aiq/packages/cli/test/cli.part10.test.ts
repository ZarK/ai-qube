import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  access,
  fixtureFile,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("runs cumulative stages for run --up-to stage shortcuts", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--up-to", "3", "--dry-run", "--format", "json"],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      plan: { stages: string[] };
    };
    expect(output.plan.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
  });

  it("supports run --only stage shortcuts using the published stage ladder", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--only", "3", "--format", "json"],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      request: { selection: { stages: string[] } };
      stages: Array<{ stageId: string }>;
    };
    expect(output.request.selection.stages).toEqual(["typecheck"]);
    expect(output.stages.map((stage) => stage.stageId)).toEqual(["typecheck"]);
  });

  it("rejects out-of-range stage shortcut flags with usage code", async () => {
    for (const argv of [
      ["node", "aiq", "run", fixtureFile, "--only", "10"],
      ["node", "aiq", "run", fixtureFile, "--up-to", "10"],
    ]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("must be between 0 and 9");
    }
  });

  it("prints a dry-run plan without executing tools or writing artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-dry-run-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        fixtureFile,
        "--stage",
        "lint",
        "--dry-run",
        "--out-dir",
        tempDir,
        "--format",
        "json",
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      dryRun: boolean;
      plan: { stages: string[]; tasks: Array<{ stageId: string }> };
    };
    expect(output.dryRun).toBe(true);
    expect(output.plan.stages).toEqual(["lint"]);
    expect(output.plan.tasks).toMatchObject([{ stageId: "lint" }]);
    await expect(access(path.join(tempDir, "aiq.plan.json"))).rejects.toThrow();
    await expect(access(path.join(tempDir, "aiq.report.json"))).rejects.toThrow();
  });
});
