import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdir,
  path,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("uses persisted current_stage as the default cumulative check target", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-check-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "src/index.ts", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      request: { selection: { stages: string[] } };
    };
    expect(output.request.selection.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
  });

  it("lets explicit run stage flags override persisted current_stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-override-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--only", "1", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as { request: { selection: { stages: string[] } } };
    expect(output.request.selection.stages).toEqual(["lint"]);
  });

  it("lets explicit run profiles override persisted current_stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-profile-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        "--profile",
        "standard",
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
    const output = JSON.parse(stdout.value) as { plan: { stages: string[] } };
    expect(output.plan.stages).toEqual(["lint", "typecheck", "unit"]);
  });

  it("lets explicit named run stages override persisted current_stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-named-stage-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        "--stage",
        "security",
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
    const output = JSON.parse(stdout.value) as { plan: { stages: string[] } };
    expect(output.plan.stages).toEqual(["security"]);
  });
});
