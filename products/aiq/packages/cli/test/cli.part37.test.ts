import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  fixtureFile,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("deduplicates repeated invocation stages", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        fixtureFile,
        "--stage",
        "lint",
        "--stage",
        "lint",
        "--stage",
        "security",
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
      stages: string[];
      tasks: Array<{ stageId: string }>;
    };
    expect(output.stages).toEqual(["lint", "security"]);
    expect(output.tasks.map((task) => task.stageId)).toEqual(["lint", "security"]);
  });

  it("fails fast when repo config is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-invalid-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const invalid = false;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "aiq.config.json"),
      '{"version":1,"surfaces":{"cli":{"profile":"broken"}}}\n',
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "plan", "src/index.ts", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("profile must be one of fast, standard, deep");
  });

  it("renders plan text output with the resolved artifact target", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-text-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        fixtureFile,
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

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain(`Artifact target: ${tempDir}`);
    expect(stdout.value).toContain("Source: direct");
  });
});
