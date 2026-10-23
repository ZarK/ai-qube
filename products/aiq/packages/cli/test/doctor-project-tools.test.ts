import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../src/args.js";
import { runDoctorCommand } from "../src/doctor-command.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createProject(scripts: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiq-doctor-project-tools-"));
  directories.push(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts }));
  await writeFile(path.join(directory, "main.js"), "export const value = 1;\n");
  vi.stubEnv("PATH", directory);
  return directory;
}

async function runDoctor(directory: string, stage: string) {
  let stdout = "";
  let stderr = "";
  const code = await runDoctorCommand(
    parseArgs(["node", "aiq", "doctor", "--stage", stage, "--format", "json"], directory),
    {
      cwd: directory,
      stdin: new PassThrough(),
      stdout: {
        write: (value) => {
          stdout += value;
          return true;
        },
      },
      stderr: {
        write: (value) => {
          stderr += value;
          return true;
        },
      },
    },
  );
  expect(stderr).toBe("");
  const output = JSON.parse(stdout) as {
    checks: Array<{ name: string; ok: boolean; required?: boolean; detail?: string }>;
  };
  return {
    code,
    npm: output.checks.find((check) => check.name === "npm package manager"),
    playwright: output.checks.find((check) => check.name === "Playwright (.)"),
  };
}

describe("doctor project host commands", () => {
  it.each(["unit", "coverage", "e2e"])("requires npm for configured %s scripts", async (stage) => {
    const directory = await createProject({ test: "vitest run", "test:e2e": "playwright test" });
    const result = await runDoctor(directory, stage);
    expect(result.code).toBe(1);
    expect(result.npm).toMatchObject({ ok: false, required: true });
    expect(result.npm?.detail).toContain("not detected");
  });

  it.each(["unit", "coverage"])("does not require npm for direct %s runners", async (stage) => {
    const directory = await createProject({ test: "vitest" });
    const result = await runDoctor(directory, stage);
    expect(result.code).toBe(0);
    expect(result.npm).toMatchObject({ ok: true, required: false });
  });

  it("reports the path and version of npm used by project scripts", async () => {
    const directory = await createProject({ test: "jest --runInBand" });
    const windows = process.platform === "win32";
    const executable = path.join(directory, windows ? "npm.cmd" : "npm");
    await writeFile(
      executable,
      windows ? "@echo off\r\necho 11.0.0\r\n" : "#!/bin/sh\necho 11.0.0\n",
      { mode: 0o755 },
    );
    const result = await runDoctor(directory, "unit");
    expect(result.code).toBe(0);
    expect(result.npm).toMatchObject({ ok: true, required: true });
    expect(result.npm?.detail).toContain(executable);
    expect(result.npm?.detail).toContain("11.0.0");
  });

  it("does not require npm for a selected lint stage", async () => {
    const directory = await createProject({ test: "vitest run", e2e: "playwright test" });
    const result = await runDoctor(directory, "lint");
    expect(result.code).toBe(0);
    expect(result.npm).toMatchObject({ ok: true, required: false });
  });

  it("does not require npm for an unconfigured e2e stage", async () => {
    const directory = await createProject({ test: "vitest run" });
    const result = await runDoctor(directory, "e2e");
    expect(result.code).toBe(1);
    expect(result.npm).toMatchObject({ ok: true, required: false });
  });

  it("finds npm requirements in nested projects", async () => {
    const directory = await createProject({ test: "vitest" });
    const nested = path.join(directory, "packages", "web");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, "package.json"),
      JSON.stringify({ scripts: { e2e: "node check.js" } }),
    );
    const result = await runDoctor(directory, "e2e");
    expect(result.code).toBe(1);
    expect(result.npm).toMatchObject({ ok: false, required: true });
  });

  it.each(["config", "dependency"])(
    "fails when Playwright %s requires a missing local executable",
    async (signal) => {
      const directory = await createProject({});
      await configurePlaywright(directory, signal);
      vi.stubEnv("PATH", "");
      const result = await runDoctor(directory, "e2e");
      expect(result.code).toBe(1);
      expect(result.playwright).toMatchObject({ ok: false, required: true, source: "project" });
      expect(result.playwright?.detail).toContain("not detected");
      expect(result.npm).toMatchObject({ ok: true, required: false });
    },
  );

  it.each(["config", "dependency"])(
    "reports the local Playwright path and version for %s without npm",
    async (signal) => {
      const directory = await createProject({});
      await configurePlaywright(directory, signal);
      const windows = process.platform === "win32";
      const binDirectory = path.join(directory, "node_modules", ".bin");
      await mkdir(binDirectory, { recursive: true });
      const executable = path.join(binDirectory, windows ? "playwright.cmd" : "playwright");
      await writeFile(
        executable,
        windows ? "@echo off\r\necho Version 1.56.0\r\n" : "#!/bin/sh\necho 'Version 1.56.0'\n",
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", "");
      const result = await runDoctor(directory, "e2e");
      expect(result.code).toBe(0);
      expect(result.playwright).toMatchObject({ ok: true, required: true, source: "project" });
      expect(result.playwright?.detail).toContain(executable);
      expect(result.playwright?.detail).toContain("1.56.0");
      expect(result.npm).toMatchObject({ ok: true, required: false });
    },
  );
});

async function configurePlaywright(directory: string, signal: string): Promise<void> {
  if (signal === "config") {
    await writeFile(path.join(directory, "playwright.config.js"), "export default {};\n");
  } else {
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "1.56.0" } }),
    );
  }
}
