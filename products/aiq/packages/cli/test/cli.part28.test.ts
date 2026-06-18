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
  it("renders coverage output as JSON for JavaScript and TypeScript fixtures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-coverage-"));
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
        "coverage",
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
      stageId: "coverage",
      status: "passed",
    });
    expect(output.stages[0]?.notes.join(" ")).toContain("Vitest coverage lines:");
    expect(output.stages[0]?.notes.join(" ")).toContain("Jest coverage lines:");
    expect(output.stages[0]?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "jest" }),
      ]),
    );
  });
});
