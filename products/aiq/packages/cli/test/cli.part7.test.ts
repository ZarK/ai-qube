import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  fixtureFile,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("does not treat command-specific flag-first invocations as the configured project gate", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-flag-first-command-option-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--corpus-root", "fixtures"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("aiq run requires explicit files or paths.");
  });

  it("keeps flag-first aiq invocations with path input on explicit targets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-flag-first-target-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "--stage", "lint", fixtureFile, "--format", "json", "--out-dir", tempDir],
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
      firstRun?: unknown;
      mode: string;
      request: {
        manifest: { files: string[]; source: string };
      };
    };
    expect(output.firstRun).toBeUndefined();
    expect(output.mode).toBe("check");
    expect(output.request.manifest.files).toEqual([fixtureFile]);
    expect(output.request.manifest.source).toBe("direct");
  });

  it("keeps explicit check without files as a usage error", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("aiq check requires explicit files or paths.");
    expect(stderr.value).toContain("Use aiq for the configured project gate");
  });

  it("rejects aiq check dot with guidance to use the configured project gate", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "."], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Use aiq for the configured project gate.");
    expect(stderr.value).toContain("aiq check <paths...>");
  });

  it("rejects aiq check project-root aliases with guidance to use the configured project gate", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", path.resolve(process.cwd())], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Use aiq for the configured project gate.");
    expect(stderr.value).toContain("aiq check <paths...>");
  });

  it("keeps explicit run focused on file and path targets", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("aiq run requires explicit files or paths.");
    expect(stderr.value).toContain("Use aiq for the configured project gate");
  });

  it("rejects aiq run dot with guidance to use the configured project gate", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "."], {
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
});
