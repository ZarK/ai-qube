import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("reports agent setup guidance for missing required host tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-setup-python-missing-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "pyproject.toml"), "[project]\nname = 'fixture'\n", "utf8");
    await writeFile(path.join(tempDir, "main.py"), "print('hello')\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        [
          "node",
          "aiq",
          "setup",
          "--stage",
          "typecheck",
          "--profile",
          "standard",
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

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      const output = JSON.parse(stdout.value) as {
        actions: Array<{ name: string; status: string }>;
        detectedTech: string[];
        missingPrerequisites: Array<{ install: string; name: string }>;
        nextCommands: string[];
        ok: boolean;
      };
      expect(output.ok).toBe(false);
      expect(output.detectedTech).toEqual(["Python"]);
      expect(output.missingPrerequisites).toEqual([
        expect.objectContaining({
          install: expect.stringContaining("Install Python 3"),
          name: "Python runtime",
        }),
      ]);
      expect(output.actions.find((action) => action.name === "Python runtime")).toMatchObject({
        status: "missing",
      });
      expect(output.nextCommands).toContain("aiq doctor --stage typecheck");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports agent setup guidance in text output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-setup-text-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "pyproject.toml"), "[project]\nname = 'fixture'\n", "utf8");
    await writeFile(path.join(tempDir, "main.py"), "print('hello')\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "setup", "--stage", "typecheck"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("AIQ setup");
      expect(stdout.value).toContain("Required setup:");
      expect(stdout.value).toContain("Python runtime");
      expect(stdout.value).toContain("Install Python 3");
      expect(stdout.value).toContain("aiq doctor --stage typecheck");
      expect(stdout.value).toContain("AIQ reports setup needs; it does not install tools");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports behavior-preserving metric remediation in setup text output", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-setup-metric-text-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    await runCli(["node", "aiq", "setup", "--stage", "sloc"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Metric remediation:");
    expect(stdout.value).toContain(
      "Treat metric remediation as behavior-preserving work, not architecture redesign.",
    );
    expect(stdout.value).toContain("Preserve public APIs, command behavior, tool selection");
    expect(stdout.value).toContain(
      "Do not use metric failures as authorization for feature changes",
    );
  });
});
