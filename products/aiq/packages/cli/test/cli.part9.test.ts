import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  fixtureFile,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("treats an existing extensionless first token as an implicit run path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-extensionless-path-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "LICENSE"), "AIQ fixture\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "LICENSE", "--stage", "e2e", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      request: { manifest: { files: string[] }; selection: { stages: string[] } };
    };
    expect(output.request.manifest.files).toEqual([path.join(tempDir, "LICENSE")]);
    expect(output.request.selection.stages).toEqual(["e2e"]);
  });

  it("treats a leading file path as an implicit run command", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", fixtureFile, "--stage", "typecheck"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Status: passed");
    expect(stdout.value).toContain("Stages: 3 typecheck passed");
    expect(stdout.value).toContain("Next: no action required.");
    expect(stdout.value).not.toContain("Artifacts:");
  });

  it("runs explicit target output with the run label", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", fixtureFile, "--stage", "typecheck"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Status: passed");
    expect(stdout.value).toContain("Stages: 3 typecheck passed");
    expect(stdout.value).toContain("Next: no action required.");
    expect(stdout.value).not.toContain("Artifacts:");
  });

  it("runs explicit check output with the check label", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", fixtureFile, "--stage", "typecheck"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ check");
    expect(stdout.value).toContain("Status: passed");
    expect(stdout.value).toContain("Stages: 3 typecheck passed");
    expect(stdout.value).toContain("Next: no action required.");
    expect(stdout.value).not.toContain("Artifacts:");
  });

  it("supports run --up-to stage shortcuts using the published stage ladder", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--up-to", "0", "--format", "json"],
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
      request: { selection: { stages: string[] } };
      stages: Array<{
        diagnostics: Array<{ source: string }>;
        stageId: string;
        status: string;
      }>;
    };
    expect(output.request.selection.stages).toEqual(["e2e"]);
    expect(output.stages).toMatchObject([{ stageId: "e2e", status: "failed" }]);
    expect(output.stages[0]?.diagnostics[0]?.source).toBe("aiq-e2e");
  });
});
