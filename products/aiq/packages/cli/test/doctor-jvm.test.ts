import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveJvmExecutionCommand } from "../../engine/src/languages/jvm-tools.js";
import { createJvmRunnerRuntime } from "../../engine/src/runner-runtimes.js";
import { parseArgs } from "../src/args.js";
import { runDoctorCommand } from "../src/doctor-command.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("doctor JVM wrappers", () => {
  it.each([
    { marker: "pom.xml", tool: "Maven", wrapper: windowsName("mvnw.cmd", "mvnw") },
    { marker: "build.gradle", tool: "Gradle", wrapper: windowsName("gradlew.bat", "gradlew") },
  ])("rejects an empty $tool wrapper through the real doctor path", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeFile(path.join(directory, testCase.wrapper), "");

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({
      ok: false,
      required: true,
      source: "external",
    });
    expect(result.output.checks).not.toContainEqual(
      expect.objectContaining({ name: path.join(directory, testCase.wrapper) }),
    );
  });

  it.each([
    { marker: "pom.xml", tool: "Maven", wrapper: windowsName("mvnw.cmd", "mvnw") },
    { marker: "build.gradle", tool: "Gradle", wrapper: windowsName("gradlew.bat", "gradlew") },
  ])("rejects a directory named like the $tool wrapper", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await mkdir(path.join(directory, testCase.wrapper));

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({ ok: false, required: true });
    expect(result.output.checks).not.toContainEqual(
      expect.objectContaining({ name: path.join(directory, testCase.wrapper) }),
    );
  });

  it.each([
    {
      marker: "pom.xml",
      reportedVersion: "Apache Maven 3.9.9",
      tool: "Maven",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      marker: "build.gradle",
      reportedVersion: "Gradle 8.12",
      tool: "Gradle",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
  ])("accepts a $tool wrapper that reports its version", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    const wrapper = path.join(directory, testCase.wrapper);
    await writeExecutable(wrapper, testCase.reportedVersion);

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(0);
    expect(findCheck(result.output, wrapper)).toMatchObject({
      detail: `${testCase.tool} project wrapper; ${testCase.reportedVersion}`,
      ok: true,
      required: true,
      source: "project",
    });
    expect(result.output.checks).not.toContainEqual(
      expect.objectContaining({ name: testCase.tool }),
    );
  });

  it.each([
    { marker: "pom.xml", tool: "Maven", wrapper: windowsName("mvnw.cmd", "mvnw") },
    { marker: "build.gradle", tool: "Gradle", wrapper: windowsName("gradlew.bat", "gradlew") },
  ])("rejects a successful $tool wrapper without its own version line", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeExecutable(path.join(directory, testCase.wrapper), 'openjdk version "24.0.1"');

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({ ok: false, required: true });
  });

  it.each([
    {
      marker: "pom.xml",
      reportedVersion: "Apache Maven 3.9.9",
      tool: "Maven",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      marker: "build.gradle",
      reportedVersion: "Gradle 8.12",
      tool: "Gradle",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
  ])("rejects a failing $tool wrapper even when it prints a version", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeExecutable(path.join(directory, testCase.wrapper), testCase.reportedVersion, 1);

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({ ok: false, required: true });
  });

  it.each([
    {
      archive: "apache-maven-3.9.9-bin.zip",
      marker: "pom.xml",
      properties: ".mvn/wrapper/maven-wrapper.properties",
      tool: "Maven",
      version: "3.9.9",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      archive: "gradle-8.12-all.zip",
      marker: "build.gradle",
      properties: "gradle/wrapper/gradle-wrapper.properties",
      tool: "Gradle",
      version: "8.12",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
  ])("accepts valid $tool wrapper properties", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    const wrapper = path.join(directory, testCase.wrapper);
    await writeExecutable(wrapper, "wrapper execution should not be required", 1);
    await writeWrapperProperties(directory, testCase.properties, testCase.archive);

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(0);
    expect(findCheck(result.output, wrapper)).toMatchObject({
      detail: `${testCase.tool} project wrapper; ${testCase.version}`,
      ok: true,
      required: true,
    });
  });

  it.each([
    {
      archive: "gradle-8.12-bin.zip",
      marker: "pom.xml",
      properties: ".mvn/wrapper/maven-wrapper.properties",
      tool: "Maven",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      archive: "apache-maven-3.9.9-bin.zip",
      marker: "build.gradle",
      properties: "gradle/wrapper/gradle-wrapper.properties",
      tool: "Gradle",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
    {
      archive: "custom-apache-maven-3.9.9-bin.zip",
      marker: "pom.xml",
      properties: ".mvn/wrapper/maven-wrapper.properties",
      tool: "Maven",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      archive: "custom-gradle-8.12-bin.zip",
      marker: "build.gradle",
      properties: "gradle/wrapper/gradle-wrapper.properties",
      tool: "Gradle",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
  ])("rejects an invalid $tool distribution archive", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeExecutable(path.join(directory, testCase.wrapper), "wrapper failed", 1);
    await writeWrapperProperties(directory, testCase.properties, testCase.archive);

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({ ok: false, required: true });
  });

  it.each([
    {
      archive: "apache-maven-3.9.9-bin.zip",
      marker: "pom.xml",
      properties: ".mvn/wrapper/maven-wrapper.properties",
      tool: "Maven",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      archive: "gradle-8.12-bin.zip",
      marker: "build.gradle",
      properties: "gradle/wrapper/gradle-wrapper.properties",
      tool: "Gradle",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
  ])("rejects a malformed $tool distribution URL", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeExecutable(path.join(directory, testCase.wrapper), "wrapper failed", 1);
    await writeWrapperProperties(directory, testCase.properties, testCase.archive, "not-a-url/");

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({ ok: false, required: true });
  });

  it.each([
    {
      binary: windowsName("mvn.cmd", "mvn"),
      marker: "pom.xml",
      reportedVersion: "Apache Maven 3.9.9",
      tool: "Maven",
      wrapper: windowsName("mvnw.cmd", "mvnw"),
    },
    {
      binary: windowsName("gradle.cmd", "gradle"),
      marker: "build.gradle",
      reportedVersion: "Gradle 8.12",
      tool: "Gradle",
      wrapper: windowsName("gradlew.bat", "gradlew"),
    },
  ])("falls back to the system $tool when its project wrapper is invalid", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeFile(path.join(directory, testCase.wrapper), "");
    await writeExecutable(path.join(directory, testCase.binary), testCase.reportedVersion);

    const result = await runDoctor(directory);
    await expectExecutionCommand(directory, testCase.tool, result.output);

    expect(result.code).toBe(0);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({
      detail: expect.stringContaining(testCase.reportedVersion),
      ok: true,
      required: true,
      source: "external",
    });
  });

  it.each([
    { marker: "pom.xml", tool: "Maven", wrapper: windowsName("mvnw.cmd", "mvnw") },
    { marker: "build.gradle", tool: "Gradle", wrapper: windowsName("gradlew.bat", "gradlew") },
  ])("selects the same ancestor $tool wrapper for doctor and execution", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    const wrapper = path.join(directory, testCase.wrapper);
    await writeExecutable(
      wrapper,
      testCase.tool === "Maven" ? "Apache Maven 3.9.9" : "Gradle 8.12",
    );
    const child = path.join(directory, "module");
    await mkdir(child);
    await writeFile(path.join(child, testCase.marker), "project marker\n");
    await writeFile(path.join(child, testCase.wrapper), "");

    const result = await runDoctor(directory);

    expect(result.code).toBe(0);
    expect(findCheck(result.output, wrapper)).toMatchObject({ ok: true, source: "project" });
    await expectExecutionCommand(child, testCase.tool, result.output, directory);
  });

  it.each([
    { marker: "pom.xml", tool: "Maven", wrapper: windowsName("mvnw.cmd", "mvnw") },
    { marker: "build.gradle", tool: "Gradle", wrapper: windowsName("gradlew.bat", "gradlew") },
  ])("does not select ancestor $tool wrappers outside the project scope", async (testCase) => {
    const directory = await createJvmProject(testCase.marker);
    await writeExecutable(
      path.join(directory, testCase.wrapper),
      testCase.tool === "Maven" ? "Apache Maven 3.9.9" : "Gradle 8.12",
    );
    const child = path.join(directory, "module");
    await mkdir(child);
    await writeFile(path.join(child, testCase.marker), "project marker\n");

    const result = await runDoctor(child);

    expect(result.code).toBe(1);
    expect(findCheck(result.output, testCase.tool)).toMatchObject({ ok: false, required: true });
    await expectExecutionCommand(child, testCase.tool, result.output);
    await expectExecutionCommand(
      child,
      testCase.tool,
      result.output,
      path.join(directory, "other"),
    );
  });
});

interface DoctorResult {
  code: number;
  output: {
    checks: Array<{
      detail?: string;
      name: string;
      ok: boolean;
      required?: boolean;
      source?: string;
    }>;
  };
}

async function expectExecutionCommand(
  directory: string,
  tool: string,
  output: DoctorResult["output"],
  root = directory,
): Promise<void> {
  const runtime = createJvmRunnerRuntime(root, undefined);
  const buildSystem = tool === "Maven" ? "maven" : "gradle";
  const command = await resolveJvmExecutionCommand(
    {
      buildFilePath: path.join(directory, buildSystem === "maven" ? "pom.xml" : "build.gradle"),
      buildSystem,
      files: [],
      projectRoot: directory,
    },
    "typecheck",
    directory,
    runtime,
  );
  const wrapper = output.checks.find((check) => check.source === "project");
  const systemCommand =
    buildSystem === "maven" ? runtime.resolveMavenCommand() : runtime.resolveGradleCommand();
  expect(command?.command).toBe(wrapper?.name ?? systemCommand);
}

async function createJvmProject(marker: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiq-doctor-jvm-wrapper-"));
  directories.push(directory);
  await writeFile(path.join(directory, marker), "project marker\n");
  await writeExecutable(
    path.join(directory, windowsName("java.cmd", "java")),
    'openjdk version "24.0.1"',
  );
  vi.stubEnv("PATH", directory);
  return directory;
}

async function runDoctor(directory: string): Promise<DoctorResult> {
  let stdout = "";
  let stderr = "";
  const code = await runDoctorCommand(
    parseArgs(["node", "aiq", "doctor", "--stage", "unit", "--format", "json"], directory),
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
  return { code, output: JSON.parse(stdout) as DoctorResult["output"] };
}

function findCheck(output: DoctorResult["output"], name: string) {
  return output.checks.find((check) => check.name === name);
}

async function writeExecutable(file: string, reportedVersion: string, exitCode = 0): Promise<void> {
  const contents =
    process.platform === "win32"
      ? `@echo off\r\necho ${reportedVersion}\r\nexit /b ${exitCode}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${reportedVersion}'\nexit ${exitCode}\n`;
  await writeFile(file, contents, { mode: 0o755 });
}

async function writeWrapperProperties(
  directory: string,
  relativePath: string,
  archive: string,
  baseUrl = "https\\://services.example.invalid/distributions/",
): Promise<void> {
  const properties = path.join(directory, relativePath);
  await mkdir(path.dirname(properties), { recursive: true });
  await writeFile(properties, `distributionUrl=${baseUrl}${archive}\n`);
}

function windowsName(windows: string, other: string): string {
  return process.platform === "win32" ? windows : other;
}
