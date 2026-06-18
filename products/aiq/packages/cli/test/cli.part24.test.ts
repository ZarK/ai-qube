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
  it("does not require valid progress when explicit run stages are selected", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-invalid-explicit-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 12, disabled: [], order: [0], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--only", "3", "--format", "json"],
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
      request: { selection: { stages: string[] } };
      workflow?: unknown;
    };
    expect(output.request.selection.stages).toEqual(["typecheck"]);
    expect(output.workflow).toBeUndefined();
  });

  it("fails with usage code when a positional input file does not exist", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-missing-positional-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "missing-cli-input.ts"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Input file not found:");
    expect(stderr.value).toContain("missing-cli-input.ts");
  });

  it("fails with usage code when a --files input does not exist", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-missing-files-flag-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "check", "--files", "missing-cli-flag-input.ts"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Input file not found:");
    expect(stderr.value).toContain("missing-cli-flag-input.ts");
  });

  it("fails with usage code when the --files-from list does not exist", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-missing-files-from-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "--files-from", "missing-files.txt"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("File list not found:");
    expect(stderr.value).toContain("missing-files.txt");
    expect(stderr.value).toContain("aiq check <paths...>");
  });

  it("fails with usage code when watch startup inputs do not resolve", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-missing-watch-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    await expect(
      runCli(["node", "aiq", "watch", "missing-watch-input.ts"], {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      }),
    ).resolves.toBe(2);

    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Input file not found:");
    expect(stderr.value).toContain("missing-watch-input.ts");
  });

  it("rejects malformed integer flags with usage code", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-malformed-integer-");
    for (const argv of [
      ["node", "aiq", "serve", "--port", "3000abc"],
      ["node", "aiq", "watch", "src/index.ts", "--debounce-ms", "40ms"],
    ]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("must be a non-negative integer");
    }
  });
});
