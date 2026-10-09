import { describe, expect, it } from "vitest";
import {
  os,
  path,
  MemoryInput,
  MemoryOutput,
  lintFailureFixtureFile,
  mkdtemp,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders format diagnostics as JSON for JSONC inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-format-"));
    tempDirs.push(tempDir);
    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(jsoncFile, '{"name" :"typescript-fixture" ,"items" :[1,2,3]}\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        jsoncFile,
        "--stage",
        "format",
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
      stages: Array<{
        diagnostics: Array<{ file: string; source: string }>;
        stageId: string;
        status: string;
      }>;
      summary: { notImplementedStageCount: number; status: string };
    };
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("failed");
    expect(output.stages[0]).toMatchObject({
      stageId: "format",
      status: "failed",
    });
    expect(output.stages[0]?.diagnostics[0]).toMatchObject({
      file: jsoncFile,
      source: "biome",
    });
  });

  it("renders check output as text from direct file input", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-text-"));
    tempDirs.push(tempDir);
    const target = path.relative(process.cwd(), lintFailureFixtureFile).split(path.sep).join("/");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        "--files",
        target,
        "--stage",
        "lint",
        "--format",
        "text",
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
    expect(stdout.value).toContain("Total execution time:");
    expect(stdout.value).toContain("): FAILED");
    expect(stdout.value).toContain("Stage 1 (lint): FAILED");
    expect(stdout.value).toContain("To debug failed stages:");
    expect(stdout.value).toContain(`aiq run ${target} --only 1 --verbose`);
    expect(stdout.value).not.toContain("Run:");
    expect(stdout.value).not.toContain("Artifacts:");
  });
});
