import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  fixtureFile,
  initializeGitRepository,
  path,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("adds verbose command details to text run output", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--stage", "typecheck", "--verbose"],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Run:");
    expect(stdout.value).toContain("Artifacts:");
    expect(stdout.value).toContain("Verbose tool details:");
    expect(stdout.value).toContain("- typecheck: tsc");
    expect(stdout.value).toContain("status=passed");
  });

  it("records diff-only intent and keeps safe stages scoped to the changed manifest", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        fixtureFile,
        "--stage",
        "lint",
        "--stage",
        "sloc",
        "--diff-only",
        "--dry-run",
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
      plan: {
        input: { files: string[] };
        request?: unknown;
        tasks: Array<{ files: string[]; stageId: string }>;
      };
    };
    expect(output.plan.input.files).toContain(fixtureFile);
    expect(output.plan.tasks).toEqual([
      expect.objectContaining({ files: [fixtureFile], stageId: "lint" }),
      expect.objectContaining({ files: [fixtureFile], stageId: "sloc" }),
    ]);
  });

  it("keeps full-run stages selected under diff-only without narrowing to safe-stage behavior", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-diff-only-full-stage-");
    const siblingFile = path.join(project.root, "src", "sibling.ts");
    await writeFile(siblingFile, "export const sibling = 2;\n", "utf8");
    await initializeGitRepository(project.root);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        "--stage",
        "lint",
        "--stage",
        "typecheck",
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
    const lintTask = output.plan.tasks.find((task) => task.stageId === "lint");
    const typecheckTask = output.plan.tasks.find((task) => task.stageId === "typecheck");
    expect(lintTask?.files).toEqual([changedFile]);
    expect(typecheckTask?.files).toContain(changedFile);
    expect(typecheckTask?.files).toContain(path.join(project.root, "tsconfig.json"));
    expect(typecheckTask?.files).toContain(siblingFile);
  });
});
