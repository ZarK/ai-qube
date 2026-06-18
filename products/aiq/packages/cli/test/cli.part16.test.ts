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
  it("reports missing required native test config for selected JS/TS unit stages", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-setup-js-test-config-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "setup", "--stage", "unit", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      actions: Array<{ detail: string; name: string; required: boolean; status: string }>;
      missingPrerequisites: Array<{ detail: string; name: string }>;
      ok: boolean;
    };
    expect(output.ok).toBe(false);
    expect(output.missingPrerequisites).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("Vitest/Jest config"),
        name: "JS/TS test config",
      }),
    ]);
    expect(output.actions.find((action) => action.name === "JS/TS test config")).toMatchObject({
      required: true,
      status: "missing",
    });
  });

  it("ignores reference-only directories when detecting doctor setup requirements", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-doctor-reference-files-");
    await mkdir(path.join(project.root, "docs"), { recursive: true });
    await writeFile(
      path.join(project.root, "docs", "example.py"),
      "print('reference only')\n",
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        ["node", "aiq", "doctor", "--stage", "typecheck", "--format", "json"],
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
        checks: Array<{ name: string; required?: boolean }>;
        detectedTech: string[];
        ok: boolean;
      };
      expect(output.ok).toBe(true);
      expect(output.detectedTech).toEqual(["TypeScript"]);
      expect(output.checks.find((check) => check.name === "Python runtime")).toBeUndefined();

      const setupStdout = new MemoryOutput();
      const setupStderr = new MemoryOutput();
      const setupExitCode = await runCli(
        ["node", "aiq", "setup", "--stage", "typecheck", "--format", "json"],
        {
          cwd: project.root,
          stderr: setupStderr,
          stdin: new MemoryInput(),
          stdout: setupStdout,
        },
      );

      expect(setupExitCode).toBe(0);
      expect(setupStderr.value).toBe("");
      const setupOutput = JSON.parse(setupStdout.value) as {
        actions: Array<{ name: string }>;
        detectedTech: string[];
        ok: boolean;
      };
      expect(setupOutput.ok).toBe(true);
      expect(setupOutput.detectedTech).toEqual(["TypeScript"]);
      expect(
        setupOutput.actions.find((action) => action.name === "Python runtime"),
      ).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns explicit setup guidance for operational commands", async () => {
    const commands: Array<[string[], string]> = [
      [["node", "aiq", "hook", "install"], "Hook setup uses the dedicated AIQ hook adapter"],
      [["node", "aiq", "ci", "setup"], "CI setup uses explicit workflow configuration"],
      [["node", "aiq", "ignore", "write"], "Ignored inputs are configured"],
    ];
    for (const [commandArgs, expected] of commands) {
      const argv = [...commandArgs];
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain(expected);
      expect(stdout.value).toContain("AIQ");
    }
  });
});
