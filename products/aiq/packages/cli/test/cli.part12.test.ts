import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  initializeGitRepository,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("uses changed files only for every diff-only safe stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-diff-only-safe-matrix-");
    const siblingFile = path.join(project.root, "src", "sibling.ts");
    await writeFile(siblingFile, "export const sibling = 2;\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const safeStages = ["lint", "format", "sloc", "complexity", "maintainability"];

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        ...safeStages.flatMap((stage) => ["--stage", stage]),
        "--diff-only",
        "--dry-run",
        "--format",
        "json",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      plan: { tasks: Array<{ files: string[]; stageId: string }> };
    };
    const changedFile = path.join(project.root, "src", "index.ts");
    for (const stage of safeStages) {
      expect(output.plan.tasks.find((task) => task.stageId === stage)?.files).toEqual([
        changedFile,
      ]);
    }
  });

  it("uses workspace files for every full-run stage under diff-only", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-diff-only-full-matrix-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    const changedFile = path.join(tempDir, "src", "index.ts");
    const siblingFile = path.join(tempDir, "src", "sibling.ts");
    await writeFile(changedFile, "export const value = 1;\n", "utf8");
    await writeFile(siblingFile, "export const sibling = 2;\n", "utf8");
    await initializeGitRepository(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const fullStages = ["e2e", "typecheck", "unit", "coverage", "security"];

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        ...fullStages.flatMap((stage) => ["--stage", stage]),
        "--diff-only",
        "--dry-run",
        "--format",
        "json",
      ],
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
      plan: { tasks: Array<{ files: string[]; stageId: string }> };
    };
    for (const stage of fullStages) {
      const files = output.plan.tasks.find((task) => task.stageId === stage)?.files;
      expect(files).toContain(changedFile);
      expect(files).toContain(siblingFile);
    }
  });

  it("fails fast when diff-only full-run stages cannot enumerate a Git workspace", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-diff-only-no-git-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--stage", "typecheck", "--diff-only", "--dry-run"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("--diff-only full-run stages require Git workspace enumeration");
  });
});
