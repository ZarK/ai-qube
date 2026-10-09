import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../src/args.js";
import { runDoctorCommand } from "../src/doctor-command.js";
import { detectJvmBuildTools } from "../src/doctor-jvm.js";
import { resolveDoctorToolRequirements } from "../src/doctor-tools.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("doctor host tools", () => {
  it("requires the detected JVM build tool and recognizes an existing project wrapper", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aiq-doctor-jvm-"));
    directories.push(directory);
    await writeFile(path.join(directory, "pom.xml"), "<project/>\n");
    expect((await detectJvmBuildTools(directory, ["sloc"])).requirements).toEqual([]);
    expect((await detectJvmBuildTools(directory, ["unit"])).requirements).toEqual([
      expect.objectContaining({ name: "Maven", binaries: ["mvn"], required: true }),
    ]);
    const wrapper = path.join(directory, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
    await writeFile(wrapper, "project wrapper\n");
    await mkdir(path.join(directory, ".mvn", "wrapper"), { recursive: true });
    await writeFile(
      path.join(directory, ".mvn", "wrapper", "maven-wrapper.properties"),
      "distributionUrl=https://example.invalid/apache-maven-3.9.9-bin.zip\n",
    );
    const result = await detectJvmBuildTools(directory, ["unit"]);
    expect(result.requirements).toEqual([]);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: wrapper, detail: "Maven project wrapper; 3.9.9", ok: true }),
    ]);
  });

  it("reports the path and version of standalone tools without requiring Python", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aiq-doctor-executables-"));
    directories.push(directory);
    await writeFile(path.join(directory, "main.py"), "value = 1\n");
    await writeFile(path.join(directory, "main.sh"), "echo hello\n");
    for (const tool of ["ruff", "shellcheck", "shfmt"]) {
      const windows = process.platform === "win32";
      await writeFile(
        path.join(directory, windows ? `${tool}.cmd` : tool),
        windows ? `@echo off\r\necho ${tool} 1.2.3\r\n` : `#!/bin/sh\necho '${tool} 1.2.3'\n`,
        { mode: 0o755 },
      );
    }
    vi.stubEnv("PATH", directory);
    let stdout = "";
    const code = await runDoctorCommand(
      parseArgs(
        ["node", "aiq", "doctor", "--stage", "lint", "--stage", "format", "--format", "json"],
        directory,
      ),
      {
        cwd: directory,
        stdin: new PassThrough(),
        stdout: {
          write: (value) => {
            stdout += value;
            return true;
          },
        },
        stderr: process.stderr,
      },
    );
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    for (const name of ["Ruff", "ShellCheck", "shfmt"]) {
      expect(output.checks.find((check: { name: string }) => check.name === name)).toMatchObject({
        ok: true,
        required: true,
        detail: expect.stringContaining(`${directory}${path.sep}`),
      });
      expect(output.checks.find((check: { name: string }) => check.name === name).detail).toContain(
        "1.2.3",
      );
    }
  });

  it("requires standalone tools only for their selected stages", () => {
    const languages = new Set(["python", "bash"] as const);
    expect(resolveDoctorToolRequirements(languages, ["lint"]).map((tool) => tool.name)).toEqual([
      "Ruff",
      "ShellCheck",
    ]);
    expect(resolveDoctorToolRequirements(languages, ["format"]).map((tool) => tool.name)).toEqual([
      "Ruff",
      "shfmt",
    ]);
    expect(resolveDoctorToolRequirements(languages, ["sloc"]).map((tool) => tool.name)).toEqual([
      "Python runtime",
      "Radon",
    ]);
  });

  it("fails with every missing required tool in JSON and text", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aiq-doctor-host-tools-"));
    directories.push(directory);
    await writeFile(path.join(directory, "main.py"), "value = 1\n");
    await writeFile(path.join(directory, "main.sh"), "echo hello\n");
    vi.stubEnv("PATH", "");
    for (const format of ["json", "text"]) {
      let stdout = "";
      let stderr = "";
      const code = await runDoctorCommand(
        parseArgs(
          [
            "node",
            "aiq",
            "doctor",
            "--stage",
            "lint",
            "--stage",
            "format",
            "--stage",
            "sloc",
            "--format",
            format,
          ],
          directory,
        ),
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
      expect(code).toBe(1);
      expect(stderr).toBe("");
      for (const name of ["Ruff", "ShellCheck", "shfmt", "Radon"]) {
        expect(stdout).toContain(name);
      }
      if (format === "json") {
        const output = JSON.parse(stdout);
        expect(output.ok).toBe(false);
        expect(
          output.checks.filter(
            (check: { required?: boolean; ok: boolean }) => check.required && !check.ok,
          ).length,
        ).toBeGreaterThanOrEqual(4);
      } else {
        expect(stdout).toContain("Status: failed");
      }
    }
  });
});
