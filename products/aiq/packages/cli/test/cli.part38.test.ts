import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders plan output from streamed file lists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-stream-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        "--stdin-file-list",
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
        stdin: new MemoryInput("test-projects/typescript/src/lint-failure.ts\n"),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      stages: string[];
      input: { source: string; summary: { fileCount: number } };
    };
    expect(output.artifactType).toBe("plan");
    expect(output.artifacts.outDir).toBe(tempDir);
    expect(output.context).toBe("cli");
    expect(output.stages).toEqual(["lint"]);
    expect(output.input.source).toBe("stream");
    expect(output.input.summary.fileCount).toBe(1);
  });

  it("renders check output from streamed file lists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-stream-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        "--stdin-file-list",
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
        stdin: new MemoryInput("test-projects/typescript/src/lint-failure.ts\n"),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      request: { manifest: { source: string; summary: { fileCount: number } } };
    };
    expect(output.artifactType).toBe("report");
    expect(output.request.manifest.source).toBe("stream");
    expect(output.request.manifest.summary.fileCount).toBe(1);
  });
});
