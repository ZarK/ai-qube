import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  lintFailureFixtureFile,
  mkdtemp,
  os,
  path,
  readFile,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders check output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        "test-projects/typescript/src/lint-failure.ts",
        "--stage",
        "lint",
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

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      stages: Array<{
        diagnostics: Array<{ file: string; source: string }>;
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      request: { context: string; outDir: string };
      summary: {
        diagnosticCount: number;
        fileCount: number;
        notImplementedStageCount: number;
        status: string;
      };
    };
    expect(output.artifactType).toBe("report");
    expect(output.artifacts.outDir).toBe(tempDir);
    expect(output.context).toBe("cli");
    expect(output.request.context).toBe("cli");
    expect(output.request.outDir).toBe(tempDir);
    expect(output.summary.diagnosticCount).toBeGreaterThan(0);
    expect(output.summary.fileCount).toBe(1);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("failed");
    expect(output.stages[0]).toMatchObject({
      stageId: "lint",
      status: "failed",
    });
    expect(output.stages[0]?.diagnostics[0]).toMatchObject({
      file: lintFailureFixtureFile,
      source: "biome",
    });
    expect(output.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "biome",
    });

    const reportJson = JSON.parse(
      await readFile(path.join(tempDir, "aiq.report.json"), "utf8"),
    ) as {
      artifactType: string;
    };
    expect(reportJson.artifactType).toBe("report");
  });
});
