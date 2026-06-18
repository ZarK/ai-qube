import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  fixtureFile,
  fixtureJavaScriptFile,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders passing typecheck output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-typecheck-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixtureFile,
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--out-dir",
        tempDir,
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
      stages: Array<{
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages[0]).toMatchObject({
      stageId: "typecheck",
      status: "passed",
    });
    expect(output.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "tsc",
    });
  });

  it("renders passing unit output as JSON for JavaScript and TypeScript projects", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-unit-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixtureFile,
        fixtureJavaScriptFile,
        "--stage",
        "unit",
        "--format",
        "json",
        "--out-dir",
        tempDir,
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
      stages: Array<{
        notes: string[];
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages[0]).toMatchObject({
      stageId: "unit",
      status: "passed",
    });
    expect(output.stages[0]?.notes.join(" ")).toContain("Vitest ran");
    expect(output.stages[0]?.notes.join(" ")).toContain("Jest ran");
    expect(output.stages[0]?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "jest" }),
      ]),
    );
  });
});
