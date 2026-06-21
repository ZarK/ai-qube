import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  chmod,
  createTypeScriptFixtureProject,
  fixtureFile,
  mkdir,
  mkdtemp,
  os,
  path,
  rm,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("rejects aiq run project-root aliases with guidance to use the configured project gate", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "./"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Use aiq for the configured project gate.");
    expect(stderr.value).toContain("aiq run <paths...>");
  });

  it("returns quality failure code and diagnostic remediation for first-run code diagnostics", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-quality-failure-");
    await writeFile(project.filePath, "export const value: string = 1;\n", "utf8");
    await mkdir(path.join(project.root, ".qube", "aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".qube", "aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ first run");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("3 typecheck failed");
    expect(stdout.value).toContain("Next: aiq setup");
    expect(stdout.value).toContain("Quality failures:");
    expect(stdout.value).toContain("First-run diagnostics:");
    expect(stdout.value).toContain("Remediation: fix the listed diagnostics");
  });

  it("returns a distinct internal error code when first-run cannot inspect cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-first-run-deleted-cwd-"));
    await rm(tempDir, { force: true, recursive: true });
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(3);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("ENOENT");
  });

  it("warns when first-run input collection reaches the safety limit", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-first-run-truncated-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "package.json"), '{"name":"truncated"}\n', "utf8");
    for (let index = 0; index < 505; index += 1) {
      await writeFile(path.join(tempDir, `file-${index}.sql`), "select 1;\n", "utf8");
    }
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Warning: first-run input collection reached its safety limit");
  });

  it("warns when first-run skips an unreadable subdirectory", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-first-run-unreadable-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "package.json"), '{"name":"unreadable"}\n', "utf8");
    const unreadableDir = path.join(tempDir, "src", "private");
    await mkdir(unreadableDir, { recursive: true });
    await writeFile(path.join(unreadableDir, "hidden.ts"), "export const hidden = true;\n", "utf8");
    await chmod(unreadableDir, 0);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    try {
      const exitCode = await runCli(["node", "aiq"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("Warning: Skipped unreadable directory");
    } finally {
      await chmod(unreadableDir, 0o700).catch(() => undefined);
    }
  });

  it("fails fast when the first token is an unknown command", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "chek", fixtureFile], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Unknown command: chek");
  });
});
