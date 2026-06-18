import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  access,
  fixtureFile,
  mkdir,
  mkdtemp,
  os,
  path,
  readFile,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("renders plan output from direct file input and the default artifact directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-default-out-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "--files", fixtureFile, "--stage", "lint", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const defaultOutDir = path.join(tempDir, ".aiq/out");
    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      input: { source: string; summary: { fileCount: number } };
      stages: string[];
    };
    expect(output.artifactType).toBe("plan");
    expect(output.artifacts.outDir).toBe(defaultOutDir);
    expect(output.context).toBe("cli");
    expect(output.input.source).toBe("direct");
    expect(output.input.summary.fileCount).toBe(1);
    expect(output.stages).toEqual(["lint"]);

    const planJson = JSON.parse(
      await readFile(path.join(defaultOutDir, "aiq.plan.json"), "utf8"),
    ) as {
      artifactType: string;
      artifacts: { outDir: string };
    };
    expect(planJson.artifactType).toBe("plan");
    expect(planJson.artifacts.outDir).toBe(defaultOutDir);
    await expect(access(path.join(defaultOutDir, "aiq.report.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("renders plan output from file-list inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-plan-"));
    tempDirs.push(tempDir);
    const fileListPath = path.join(tempDir, "files.txt");
    await writeFile(fileListPath, `${fixtureFile}\n`, "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        "--files-from",
        fileListPath,
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
    expect(output.input.source).toBe("file-list");
    expect(output.input.summary.fileCount).toBe(1);

    const planJson = JSON.parse(await readFile(path.join(tempDir, "aiq.plan.json"), "utf8")) as {
      artifactType: string;
    };
    expect(planJson.artifactType).toBe("plan");
  });

  it("resolves --files-from relative to the CLI cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-files-from-cwd-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/input.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(tempDir, "files.txt"), "src/input.ts\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "--files-from", "files.txt", "--stage", "lint", "--format", "json"],
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
      input: { files: string[]; source: string };
    };
    expect(output.input.source).toBe("file-list");
    expect(output.input.files).toEqual([path.join(tempDir, "src/input.ts")]);
  });
});
