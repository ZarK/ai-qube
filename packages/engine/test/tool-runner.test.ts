import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ToolRunOutcome, ToolRunner } from "../src/tool-runner.js";

function createOutcome(overrides: Partial<ToolRunOutcome> = {}): ToolRunOutcome {
  return {
    durationMs: 1,
    exitCode: 0,
    finishedAt: "2026-03-25T00:00:01.000Z",
    startedAt: "2026-03-25T00:00:00.000Z",
    stderr: "",
    stdout: "",
    ...overrides,
  };
}

describe("ToolRunner binary lookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps graceful not-found behavior for which/where fallback", async () => {
    const runner = new ToolRunner();

    vi.spyOn(runner, "resolveInstalledBinary").mockResolvedValue(undefined);
    const runSpy = vi.spyOn(runner, "run").mockResolvedValue(createOutcome({ exitCode: 1 }));

    await expect(runner.resolveBinaryIfAvailable(["missing-binary"])).resolves.toBeUndefined();
    expect(runSpy).toHaveBeenCalledWith(
      process.platform === "win32" ? "where" : "which",
      ["missing-binary"],
      { cwd: process.cwd() },
    );
  });

  it("normalizes missing executables into outcomes", async () => {
    const runner = new ToolRunner();

    const outcome = await runner.run(`aiq-missing-command-${process.pid}`, [], {
      cwd: process.cwd(),
    });

    expect(outcome.exitCode).toBeUndefined();
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).toBe("");
  });

  it.skipIf(process.platform !== "win32")(
    "normalizes unspawnable Windows shims into outcomes",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tool-runner-shim-"));
      const shimPath = path.join(tempDir, "npm");

      try {
        await writeFile(shimPath, "not a Windows executable\n", "utf8");

        const runner = new ToolRunner();
        const outcome = await runner.run(shimPath, [], { cwd: tempDir });

        expect(outcome.exitCode).toBeUndefined();
        expect(outcome.stderr).toBe("");
        expect(outcome.stdout).toBe("");
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "runs Windows command scripts through the platform shell",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tool-runner-"));
      const scriptPath = path.join(tempDir, "echo.cmd");

      try {
        await writeFile(scriptPath, "@echo off\r\necho %~1\r\n", "utf8");

        const runner = new ToolRunner();
        const outcome = await runner.run(scriptPath, ["script-ok"], { cwd: tempDir });

        expect(outcome.exitCode).toBe(0);
        expect(outcome.stdout.trim()).toBe("script-ok");
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "passes Windows command script metacharacters as arguments",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tool-runner-metachar-"));
      const scriptPath = path.join(tempDir, "echo.cmd");

      try {
        await writeFile(scriptPath, '@echo off\r\necho "%~1"\r\n', "utf8");

        const runner = new ToolRunner();
        const outcome = await runner.run(scriptPath, ["safe&echo injected"], { cwd: tempDir });

        expect(outcome.exitCode).toBe(0);
        expect(outcome.stdout.trim()).toBe('"safe&echo injected"');
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "does not expand Windows command script percent variables in arguments",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tool-runner-percent-"));
      const scriptPath = path.join(tempDir, "echo.cmd");

      try {
        await writeFile(scriptPath, '@echo off\r\necho "%~1"\r\n', "utf8");

        const runner = new ToolRunner();
        const outcome = await runner.run(scriptPath, ["%AIQ_TOOL_RUNNER_TEST_VALUE%"], {
          cwd: tempDir,
          env: { AIQ_TOOL_RUNNER_TEST_VALUE: "expanded" },
        });

        expect(outcome.exitCode).toBe(0);
        expect(outcome.stdout).not.toContain("expanded");
        expect(outcome.stdout).toContain("AIQ_TOOL_RUNNER_TEST_VALUE");
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "preserves Windows command script failure exit codes",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-tool-runner-fail-"));
      const scriptPath = path.join(tempDir, "fail with spaces.cmd");

      try {
        await writeFile(
          scriptPath,
          "@echo off\r\necho failed-script 1>&2\r\nexit /b 7\r\n",
          "utf8",
        );

        const runner = new ToolRunner();
        const outcome = await runner.run(scriptPath, ["quoted arg"], { cwd: tempDir });

        expect(outcome.exitCode).toBe(7);
        expect(outcome.stderr.trim()).toBe("failed-script");
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "prefers Windows executable command paths over extensionless shims",
    async () => {
      const runner = new ToolRunner();
      const extensionlessPath = path.join("C:\\tools", "npm");
      const commandScriptPath = `${extensionlessPath}.cmd`;

      vi.spyOn(runner, "resolveInstalledBinary").mockResolvedValue(undefined);
      vi.spyOn(runner, "run").mockResolvedValue(
        createOutcome({ stdout: `${extensionlessPath}\r\n${commandScriptPath}\r\n` }),
      );

      await expect(runner.resolveBinaryIfAvailable(["npm"])).resolves.toBe(commandScriptPath);
    },
  );

  it("rethrows unexpected exec-file string-code failures", async () => {
    const runner = new ToolRunner();

    await expect(
      runner.run(process.execPath, ["-e", 'process.stdout.write("x".repeat(4096))'], {
        cwd: process.cwd(),
        maxBuffer: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("propagates aborts from asdf binary lookup", async () => {
    const runner = new ToolRunner();
    const abortError = new Error("lookup aborted");
    abortError.name = "AbortError";

    vi.spyOn(runner, "run").mockRejectedValue(abortError);

    await expect(runner.resolveInstalledBinary("node")).rejects.toBe(abortError);
  });

  it("propagates unexpected asdf binary lookup failures", async () => {
    const runner = new ToolRunner();
    const lookupError = new Error("asdf lookup exploded");

    vi.spyOn(runner, "run").mockRejectedValue(lookupError);

    await expect(runner.resolveInstalledBinary("node")).rejects.toBe(lookupError);
  });

  it("treats unspawnable asdf lookup as unavailable instead of crashing", async () => {
    const runner = new ToolRunner();
    const lookupError = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });

    vi.spyOn(runner, "run").mockRejectedValue(lookupError);

    await expect(runner.resolveInstalledBinary("node")).resolves.toBeUndefined();
  });

  it("propagates aborts from which/where fallback", async () => {
    const runner = new ToolRunner();
    const abortError = new Error("lookup aborted");
    abortError.name = "AbortError";

    vi.spyOn(runner, "resolveInstalledBinary").mockResolvedValue(undefined);
    vi.spyOn(runner, "run").mockRejectedValue(abortError);

    await expect(runner.resolveBinaryIfAvailable(["node"])).rejects.toBe(abortError);
  });

  it("propagates unexpected which/where lookup failures", async () => {
    const runner = new ToolRunner();
    const lookupError = new Error("which lookup exploded");

    vi.spyOn(runner, "resolveInstalledBinary").mockResolvedValue(undefined);
    vi.spyOn(runner, "run").mockRejectedValue(lookupError);

    await expect(runner.resolveBinaryIfAvailable(["node"])).rejects.toBe(lookupError);
  });
});
