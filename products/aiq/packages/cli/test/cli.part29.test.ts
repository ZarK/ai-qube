import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  fixturePythonFile,
  hasPythonQualityToolchain,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it.skipIf(!hasPythonQualityToolchain)("renders passing Python output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-python-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixturePythonFile,
        "--stage",
        "lint",
        "--stage",
        "format",
        "--stage",
        "typecheck",
        "--stage",
        "unit",
        "--stage",
        "coverage",
        "--stage",
        "complexity",
        "--stage",
        "maintainability",
        "--stage",
        "security",
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
        toolRuns: Array<{ cacheHit?: boolean; exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages).toHaveLength(8);
    expect(output.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "ruff",
    });
    expect(output.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
      "Pytest ran",
    );
    expect(output.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
      "Pytest coverage lines:",
    );
    expect(
      output.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
    ).toContain("Reused cached Python metrics");
    expect(
      output.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
    ).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "radon",
    });
  });
});
