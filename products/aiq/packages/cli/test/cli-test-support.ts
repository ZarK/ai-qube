import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";

import { parseAiuTrustedStateJson } from "@tjalve/aiu";
import { afterEach, describe, expect, it } from "vitest";
import { withExclusiveToolLock } from "../../engine/test/exclusive-tool-lock.js";
import {
  hasDotNet10Toolchain,
  hasPythonQualityToolchain,
} from "../../engine/test/toolchain-capabilities.js";
import type { RunRequest, RunResult } from "../../model/src/index.js";
import { runCli } from "../src/index.js";
import { writeServeListeningOutput } from "../src/output.js";
import { createRunWorkflowOutput } from "../src/workflow.js";

export const repoRoot = path.resolve(".");
export const npmCommand =
  process.platform === "win32"
    ? {
        argsPrefix: [
          path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
        ],
        executable: process.execPath,
      }
    : { argsPrefix: [], executable: "npm" };
export const builtCliPath = path.join(repoRoot, "packages", "cli", "dist", "bin", "aiq.js");
export const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
export const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
export const fixtureJavaScriptFile = path.resolve("test-projects/javascript/index.js");
export const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
export const fixturePythonFile = path.resolve("test-projects/python/main.py");
export const fixtureTsconfig = path.resolve("test-projects/typescript/tsconfig.json");
export const cliPackageJsonPath = path.join(repoRoot, "packages", "cli", "package.json");
export const packageSmokeWorkspaces = ["packages/cli"] as const;
export const approvedPackageSmokeDependencies = [
  {
    name: "@tjalve/qube-cli",
    packageRoot: path.join(repoRoot, "packages", "cli", "node_modules", "@tjalve", "qube-cli"),
    version: "0.1.2",
  },
] as const;
export const publishedPackageWorkspaces = ["packages/cli"] as const;
export const internalPackageWorkspaces = [
  "packages/benchmark",
  "packages/config-schema",
  "packages/engine",
  "packages/github-action",
  "packages/hook",
  "packages/lsp",
  "packages/model",
  "packages/opencode-plugin",
  "packages/reporters",
] as const;
export const adapterPackageWorkspaces = [
  "packages/github-action",
  "packages/hook",
  "packages/lsp",
  "packages/opencode-plugin",
] as const;
export const describePackageSmoke = process.env.AIQ_SMOKE === "1" ? describe : describe.skip;

export let packageSmokeBuildPromise: Promise<void> | undefined;

export class MemoryOutput {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

export class MemoryInput {
  private readonly data: string;

  constructor(data = "") {
    this.data = data;
  }

  on(event: "data", handler: (value: string) => void): this;
  on(event: "end", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(
    event: string,
    handler: ((value: string) => void) | (() => void) | ((error: Error) => void),
  ): this {
    if (event === "data" && this.data.length > 0) {
      queueMicrotask(() => {
        (handler as (value: string) => void)(this.data);
      });
    }

    if (event === "end") {
      queueMicrotask(() => {
        (handler as () => void)();
      });
    }

    return this;
  }

  resume(): this {
    return this;
  }

  setEncoding(_encoding?: BufferEncoding): this {
    return this;
  }
}

export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export async function waitFor<T>(
  getValue: () => Promise<T | undefined> | T | undefined,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await getValue();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

export function parseJsonLines<T>(value: string): T[] {
  const lines = value.split("\n");
  return lines.flatMap((line, index) => {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return [];
    }

    try {
      return [JSON.parse(trimmedLine) as T];
    } catch (error) {
      const isIncompleteTrailingLine = index === lines.length - 1 && !value.endsWith("\n");
      if (isIncompleteTrailingLine) {
        return [];
      }
      throw error;
    }
  });
}

export type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd ?? repoRoot,
        env: {
          ...process.env,
          CI: "true",
          ...options.env,
        },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stderr, stdout });
          return;
        }

        if (typeof error.code === "number") {
          resolve({ exitCode: error.code, stderr, stdout });
          return;
        }

        reject(error);
      },
    );
  });
}

export function runNpmCommand(
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand(npmCommand.executable, [...npmCommand.argsPrefix, ...args], options);
}

export async function ensurePackageSmokeBuild(): Promise<void> {
  packageSmokeBuildPromise ??= withExclusiveToolLock("cli-package-smoke-build", async () => {
    const buildResult = await runNpmCommand(
      [
        "run",
        "build",
        ...packageSmokeWorkspaces.flatMap((workspace) => ["--workspace", workspace]),
      ],
      { cwd: repoRoot },
    );
    expect(buildResult.exitCode).toBe(0);
  });

  await packageSmokeBuildPromise;
}

export interface PackedWorkspacePackage {
  files: Array<{ path: string }>;
  tarballPath: string;
  workspace: (typeof packageSmokeWorkspaces)[number];
}

export async function packWorkspacePackage(
  workspace: (typeof packageSmokeWorkspaces)[number],
): Promise<PackedWorkspacePackage> {
  const packResult = await runNpmCommand(["pack", "--json", "--workspace", workspace], {
    cwd: repoRoot,
  });

  expect(packResult.exitCode).toBe(0);
  const [packMetadata] = JSON.parse(packResult.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  expect(packMetadata).toBeDefined();

  const tarballPath = path.join(repoRoot, packMetadata.filename);
  tempArtifacts.push(tarballPath);
  return {
    files: packMetadata.files,
    tarballPath,
    workspace,
  };
}

export async function packApprovedPackageSmokeDependency(
  dependency: (typeof approvedPackageSmokeDependencies)[number],
  destination: string,
): Promise<string> {
  await access(dependency.packageRoot);
  const packResult = await runNpmCommand(
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
      dependency.packageRoot,
    ],
    {
      cwd: repoRoot,
    },
  );

  expect(packResult.exitCode, packResult.stderr || packResult.stdout).toBe(0);
  const [packMetadata] = JSON.parse(packResult.stdout) as Array<{
    filename: string;
    name: string;
    version: string;
  }>;
  expect(packMetadata).toMatchObject({
    name: dependency.name,
    version: dependency.version,
  });

  return path.join(destination, packMetadata.filename);
}

export async function createPackedPackageFixture(): Promise<{
  fixtureFilePath: string;
  packages: PackedWorkspacePackage[];
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-package-smoke-"));
  tempArtifacts.push(root);

  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "aiq-cli-package-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  const fixtureFilePath = path.join(root, "src", "index.ts");
  await writeFile(fixtureFilePath, "export const value = 1;\n", "utf8");

  const [packages, approvedDependencies] = await Promise.all([
    Promise.all(packageSmokeWorkspaces.map(packWorkspacePackage)),
    Promise.all(
      approvedPackageSmokeDependencies.map((dependency) =>
        packApprovedPackageSmokeDependency(dependency, root),
      ),
    ),
  ]);

  const installResult = await runNpmCommand(
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      ...packages.map((entry) => entry.tarballPath),
      ...approvedDependencies,
    ],
    {
      cwd: root,
    },
  );
  expect(installResult.exitCode, installResult.stderr || installResult.stdout).toBe(0);

  return { fixtureFilePath, packages, root };
}

export async function createTypeScriptFixtureProject(
  prefix: string,
): Promise<{ filePath: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);

  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "tsconfig.json"),
    await readFile(fixtureTsconfig, "utf8"),
    "utf8",
  );
  const filePath = path.join(root, "src", "index.ts");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  return { filePath, root };
}

export async function initializeGitRepository(root: string): Promise<void> {
  const result = await runCommand("git", ["init"], { cwd: root });
  expect(result.exitCode).toBe(0);
}

export async function createDotNetFixtureProject(
  prefix: string,
): Promise<{ filePath: string; root: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureDotNetRoot, root, { recursive: true });
  await Promise.all([
    rm(path.join(root, "src", "DotNetFixture", "bin"), { force: true, recursive: true }),
    rm(path.join(root, "src", "DotNetFixture", "obj"), { force: true, recursive: true }),
    rm(path.join(root, "tests", "DotNetFixture.Tests", "bin"), {
      force: true,
      recursive: true,
    }),
    rm(path.join(root, "tests", "DotNetFixture.Tests", "obj"), {
      force: true,
      recursive: true,
    }),
  ]);

  return {
    filePath: path.join(root, "src", "DotNetFixture", "Greeter.cs"),
    root,
  };
}

export const tempDirs: string[] = [];
export const tempArtifacts: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
    ...tempArtifacts.splice(0).map((artifact) => rm(artifact, { force: true, recursive: true })),
  ]);
});
export type { IncomingHttpHeaders, RunRequest, RunResult };
export {
  access,
  afterEach,
  chmod,
  cp,
  createRunWorkflowOutput,
  describe,
  execFile,
  expect,
  hasDotNet10Toolchain,
  hasPythonQualityToolchain,
  httpRequest,
  it,
  mkdir,
  mkdtemp,
  os,
  parseAiuTrustedStateJson,
  path,
  readFile,
  rm,
  runCli,
  withExclusiveToolLock,
  writeFile,
  writeServeListeningOutput,
};
