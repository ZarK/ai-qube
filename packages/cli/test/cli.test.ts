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

const repoRoot = path.resolve(".");
const npmCommand =
  process.platform === "win32"
    ? {
        argsPrefix: [
          path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
        ],
        executable: process.execPath,
      }
    : { argsPrefix: [], executable: "npm" };
const builtCliPath = path.join(repoRoot, "packages", "cli", "dist", "bin", "aiq.js");
const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
const fixtureJavaScriptFile = path.resolve("test-projects/javascript/index.js");
const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
const fixturePythonFile = path.resolve("test-projects/python/main.py");
const fixtureTsconfig = path.resolve("test-projects/typescript/tsconfig.json");
const packageSmokeWorkspaces = ["packages/cli"] as const;
const approvedPackageSmokeDependencies = [
  {
    name: "@tjalve/qube-cli",
    packageRoot: path.join(repoRoot, "packages", "cli", "node_modules", "@tjalve", "qube-cli"),
    version: "0.1.1",
  },
] as const;
const publishedPackageWorkspaces = ["packages/cli"] as const;
const internalPackageWorkspaces = [
  "packages/benchmark",
  "packages/config-schema",
  "packages/engine",
  "packages/github-action",
  "packages/hook",
  "packages/lsp",
  "packages/mcp",
  "packages/model",
  "packages/opencode-plugin",
  "packages/reporters",
] as const;
const adapterPackageWorkspaces = [
  "packages/github-action",
  "packages/hook",
  "packages/lsp",
  "packages/mcp",
  "packages/opencode-plugin",
] as const;
const describePackageSmoke = process.env.AIQ_SMOKE === "1" ? describe : describe.skip;

let packageSmokeBuildPromise: Promise<void> | undefined;

class MemoryOutput {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

class MemoryInput {
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

async function waitFor<T>(
  getValue: () => T | undefined,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = getValue();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function parseJsonLines<T>(value: string): T[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function runCommand(
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

function runNpmCommand(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return runCommand(npmCommand.executable, [...npmCommand.argsPrefix, ...args], options);
}

async function ensurePackageSmokeBuild(): Promise<void> {
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

interface PackedWorkspacePackage {
  files: Array<{ path: string }>;
  tarballPath: string;
  workspace: (typeof packageSmokeWorkspaces)[number];
}

async function packWorkspacePackage(
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

async function packApprovedPackageSmokeDependency(
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

async function createPackedPackageFixture(): Promise<{
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

async function createTypeScriptFixtureProject(
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

async function initializeGitRepository(root: string): Promise<void> {
  const result = await runCommand("git", ["init"], { cwd: root });
  expect(result.exitCode).toBe(0);
}

async function createDotNetFixtureProject(
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

const tempDirs: string[] = [];
const tempArtifacts: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
    ...tempArtifacts.splice(0).map((artifact) => rm(artifact, { force: true, recursive: true })),
  ]);
});

describe("CLI foundation", () => {
  it("keeps published package metadata aligned with the clean repository", async () => {
    for (const workspace of publishedPackageWorkspaces) {
      const packageJson = JSON.parse(
        await readFile(path.join(repoRoot, workspace, "package.json"), "utf8"),
      ) as {
        bin?: Record<string, string>;
        dependencies?: Record<string, string>;
        description?: string;
        files: string[];
        name: string;
        publishConfig: { access: string; provenance: boolean };
        repository: { directory: string; type: string; url: string };
        version: string;
      };

      expect(packageJson.name).toBe("@tjalve/aiq");
      expect(packageJson.description).toContain("remediation guidance");
      expect(packageJson.publishConfig).toEqual({ access: "public", provenance: true });
      expect(packageJson.repository).toEqual({
        directory: workspace,
        type: "git",
        url: "git+https://github.com/ZarK/ai-quality.git",
      });
      expect(packageJson.files).toContain("dist");
      expect(
        Object.values(packageJson.bin ?? {}).every((binPath) => !binPath.startsWith("./")),
      ).toBe(true);

      for (const [dependencyName, dependencyVersion] of Object.entries(
        packageJson.dependencies ?? {},
      )) {
        expect(dependencyName.startsWith("@tjalve/aiq-")).toBe(false);
        if (dependencyName === "@tjalve/aiq") {
          expect(dependencyVersion).toBe(packageJson.version);
        }
      }
    }

    const packageReadme = await readFile(path.join(repoRoot, "packages", "cli", "README.md"), {
      encoding: "utf8",
    });
    expect(packageReadme).toContain(
      "Metric stages enforce SLOC, complexity, maintainability, and readability defaults for source and test code.",
    );
    expect(packageReadme).toContain("Before broad refactoring, make stage `0` e2e pass.");
    expect(packageReadme).toContain("direct purpose-revealing names");
  });

  it("keeps former split packages private to the workspace", async () => {
    for (const workspace of internalPackageWorkspaces) {
      const packageJson = JSON.parse(
        await readFile(path.join(repoRoot, workspace, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        name: string;
        private?: boolean;
        publishConfig?: unknown;
      };

      expect(packageJson.private).toBe(true);
      expect(packageJson.publishConfig).toBeUndefined();
      expect(packageJson.name.startsWith("@tjalve/aiq-")).toBe(false);

      for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
        expect(dependencyName.startsWith("@tjalve/aiq-")).toBe(false);
      }
    }
  });

  it("keeps adapter packages on the canonical aiq package surface", async () => {
    for (const workspace of adapterPackageWorkspaces) {
      const packageJson = JSON.parse(
        await readFile(path.join(repoRoot, workspace, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; version: string };
      const aiqDependencies = Object.keys(packageJson.dependencies ?? {}).filter((dependency) =>
        dependency.startsWith("@tjalve/aiq"),
      );

      expect(packageJson.dependencies?.["@tjalve/aiq"]).toBe(packageJson.version);
      expect(aiqDependencies).toEqual(["@tjalve/aiq"]);
    }
  });

  it("restores the published quality bin alias", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ) as { bin?: Record<string, string>; exports?: Record<string, unknown> };

    expect(packageJson.bin).toMatchObject({
      aiq: "dist/bin/aiq.js",
      quality: "dist/bin/aiq.js",
    });
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
      ".",
      "./api",
      "./benchmark",
      "./config",
      "./engine",
      "./model",
      "./reporters",
      "./schema",
    ]);
  });

  it("shows help and exits with 0", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--help"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Usage:");
    expect(stdout.value).toContain("aiq [--up-to <0-9>");
    expect(stdout.value).toContain("aiq <files...>");
    expect(stdout.value).toContain("aiq run <files...>");
    expect(stdout.value).toContain(
      "aiq bench [--corpus-root <path>] [--scenario <id>] [--tag <tag>] [--kind <cold|warm|diff-only>]",
    );
    expect(stdout.value).toContain("aiq check <files...>");
    expect(stdout.value).toContain("aiq config [--print-config | --set-stage <0-9>]");
    expect(stdout.value).toContain("aiq doctor");
    expect(stdout.value).toContain("aiq evidence [--format json]");
    expect(stdout.value).toContain("aiq status [--format <json|text>]");
    expect(stdout.value).toContain("aiq setup");
    expect(stdout.value).toContain("aiq schema [--format json]");
    expect(stdout.value).toContain("aiq hook install");
    expect(stdout.value).toContain("aiq ci setup");
    expect(stdout.value).toContain("aiq ignore write");
    expect(stdout.value).toContain("The bare aiq command is the configured project gate.");
    expect(stdout.value).toContain("Run is the explicit target command");
    expect(stdout.value).toContain("Check accepts the same explicit target inputs as run.");
    expect(stdout.value).toContain("Examples:");
    expect(stdout.value).toContain("aiq --format json");
    expect(stdout.value).toContain("aiq config --set-stage 3");
    expect(stdout.value).toContain("aiq run src --up-to 3");
    expect(stdout.value).toContain("aiq evidence --format json");
    expect(stdout.value).toContain("aiq schema --format json");
    expect(stdout.value).toContain("0=e2e 1=lint 2=format 3=typecheck");
    expect(stdout.value).toContain(
      "By default aiq, aiq run, and aiq plan use cumulative ladder stages 0 through .aiq/progress.json current_stage when present",
    );
    expect(stdout.value).toContain("then run aiq for the normal cumulative project workflow");
    expect(stdout.value).toContain("Use aiq run <paths...> for explicit file and subtree checks");
    expect(stdout.value).toContain("--only <0-9>");
    expect(stdout.value).toContain("--diff-only");
    expect(stdout.value).toContain("--dry-run");
    expect(stdout.value).toContain("--print-config");
    expect(stdout.value).toContain("--set-stage <0-9>");
    expect(stdout.value).toContain("--up-to <0-9>");
    expect(stdout.value).toContain("--verbose, -v");
    expect(stdout.value).toContain("aiq config initializes .aiq/aiq.config.json");
    expect(stdout.value).toContain("aiq doctor validates config/progress state");
    expect(stdout.value).toContain("aiq setup gives agent-facing setup steps");
    expect(stdout.value).toContain("aiq evidence emits structured AIQ quality evidence");
    expect(stdout.value).toContain("aiq status shows the current stage");
    expect(stdout.value).toContain("Metric remediation:");
    expect(stdout.value).toContain("Stages 5-7 enforce SLOC, complexity, maintainability");
    expect(stdout.value).toContain("Do not start broad refactors until stage 0 e2e passes");
    expect(stdout.value).toContain("Use direct purpose-revealing names");
    expect(stdout.value).toContain("no vague helper/manager/processor names");
    expect(stdout.value).toContain("@tjalve/aiq/api exports the model, config, engine");
    expect(stdout.value).toContain("aiq schema --format json expose QUBE-compatible");
    expect(stdout.value).toContain("aiq watch <files...>");
    expect(stdout.value).toContain("aiq serve [--host <host>] [--port <port>]");
  });

  it("shows the same command contract from aiq run --help", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "--help"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("aiq run <files...>");
    expect(stdout.value).toContain("Examples:");
    expect(stdout.value).toContain("Stage ladder:");
    expect(stdout.value).toContain("--stage <name> is the advanced named-stage form");
    expect(stdout.value).toContain("--up-to N runs every ladder stage from 0 through N.");
  });

  it("renders a QUBE-compatible command schema", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "schema", "--format", "json"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const schema = JSON.parse(stdout.value) as {
      bin: string;
      commands: Array<{
        name: string;
        dryRun: { supported: boolean };
        extensions?: { aiq?: { capability?: string; contexts?: string[]; targetMode?: string } };
        output: { defaultFormat?: string; formats: string[] };
        supplyChain: { kinds: string[]; sensitive: boolean };
      }>;
      extensions?: {
        aiq?: { defaultCommand?: string; explicitTargetCommand?: string };
        qube?: { discoverable?: boolean };
      };
      package: { name: string; version: string };
      schemaVersion: number;
      sections?: { discovery?: { command?: string; packageExport?: string } };
    };
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ) as { name: string; version: string };
    const commands = new Map(schema.commands.map((command) => [command.name, command]));

    expect(schema.schemaVersion).toBe(1);
    expect(schema.package).toEqual({ name: packageJson.name, version: packageJson.version });
    expect(schema.bin).toBe("aiq");
    expect(schema.extensions?.qube?.discoverable).toBe(true);
    expect(schema.extensions?.aiq?.defaultCommand).toBe("aiq");
    expect(schema.extensions?.aiq?.explicitTargetCommand).toBe("aiq run <paths...>");
    expect(schema.sections?.discovery).toEqual({
      command: "aiq schema --format json",
      packageExport: "@tjalve/aiq/schema",
    });
    expect([...commands.keys()]).toEqual([
      "config",
      "doctor",
      "evidence",
      "plan",
      "run",
      "schema",
      "setup",
      "status",
    ]);
    expect(commands.get("run")?.extensions?.aiq?.capability).toBe("quality-control");
    expect(commands.get("run")?.extensions?.aiq?.contexts).toContain("qube");
    expect(commands.get("run")?.extensions?.aiq?.targetMode).toBe("explicit-paths");
    expect(commands.get("run")?.dryRun.supported).toBe(true);
    expect(commands.get("run")?.supplyChain).toMatchObject({
      kinds: ["dependency", "package-manager"],
      sensitive: true,
    });
    expect(commands.get("setup")?.extensions?.aiq?.capability).toBe("quality-setup");
    expect(commands.get("schema")?.output).toEqual({
      defaultFormat: "json",
      formats: ["json"],
    });
    expect(commands.get("evidence")?.output).toEqual({
      defaultFormat: "json",
      formats: ["json"],
    });
  });

  it("rejects text output for JSON-only commands", async () => {
    for (const [args, message] of [
      [
        ["node", "aiq", "schema", "--format", "text"],
        "The schema command only supports --format json.",
      ],
      [
        ["node", "aiq", "schema", "--format", "text", "--format", "json"],
        "The schema command only supports --format json.",
      ],
      [
        ["node", "aiq", "evidence", "--format", "text"],
        "The evidence command only supports --format json.",
      ],
      [
        ["node", "aiq", "evidence", "--format", "text", "--format", "json"],
        "The evidence command only supports --format json.",
      ],
    ] as const) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(args, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain(message);
    }
  });

  it("shows help for operational guidance commands without requiring subcommands", async () => {
    for (const command of ["doctor", "setup", "hook", "ci", "ignore"]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(["node", "aiq", command, "--help"], {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("AIQ CLI");
      expect(stdout.value).toContain("aiq doctor");
    }
  });

  it("accepts npm exec separators before the actual CLI command", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--", "--help"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Usage:");
  });

  it("prints first-run setup guidance when no supported project can be inferred", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-first-run-empty-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ first run");
    expect(stdout.value).toContain("No supported project marker was found");
    expect(stdout.value).toContain("aiq run <files...>");
    expect(stdout.value).toContain("package.json");
  });

  it("runs no-arg first-run from an inferred project and initializes config state", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-typescript-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ first run");
    expect(stdout.value).toContain("Detected project: TypeScript (tsconfig.json)");
    expect(stdout.value).toContain("Target: .");
    expect(stdout.value).toContain("Stages: lint");
    expect(stdout.value).toContain("Change stage: aiq config --set-stage <0-9>");
    expect(stdout.value).toContain("Prepare missing tools/config: aiq setup");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("- lint: passed");

    const config = JSON.parse(
      await readFile(path.join(project.root, ".aiq", "aiq.config.json"), "utf8"),
    ) as { version: number };
    const progress = JSON.parse(
      await readFile(path.join(project.root, ".aiq", "progress.json"), "utf8"),
    ) as { current_stage: number; disabled: number[]; last_run: string | null; order: number[] };
    expect(config).toEqual({ version: 1 });
    expect(progress).toEqual({
      current_stage: 1,
      disabled: [],
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      last_run: null,
    });

    const statusStdout = new MemoryOutput();
    const statusStderr = new MemoryOutput();
    const statusExitCode = await runCli(["node", "aiq", "status", "--format", "json"], {
      cwd: project.root,
      stderr: statusStderr,
      stdin: new MemoryInput(),
      stdout: statusStdout,
    });

    expect(statusExitCode).toBe(0);
    expect(statusStderr.value).toBe("");
    const status = JSON.parse(statusStdout.value) as {
      artifactPaths: { plan: string; report: string };
      currentStage: { id: string; index: number; name: string };
      defaultRun: { range: string; stages: Array<{ id: string }> };
      lastRun: { status: string };
      nextCommand: string;
      selectedStages: string[];
    };
    expect(status.currentStage).toEqual({ id: "lint", index: 1, name: "lint" });
    expect(status.defaultRun.range).toBe("0..1");
    expect(status.defaultRun.stages.map((stage) => stage.id)).toEqual(["e2e", "lint"]);
    expect(status.selectedStages).toEqual(["e2e", "lint"]);
    expect(status.lastRun.status).toBe("passed");
    expect(status.nextCommand).toBe("aiq config --set-stage 2");
    expect(status.artifactPaths.report).toBe(
      path.join(project.root, ".aiq", "out", "aiq.report.json"),
    );
  });

  it("keeps option-only aiq invocations on the configured project gate", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-json-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain('"firstRun"');
    expect(stdout.value).toContain('"target": "."');
    expect(stdout.value).toContain('"mode": "check"');
    expect(stdout.value).toContain('"source": "direct"');
  });

  it("prints a first-run dry-run plan for the configured project gate", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-dry-run-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--dry-run", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain('"firstRun"');
    expect(stdout.value).toContain('"target": "."');
    expect(stdout.value).toContain('"dryRun": true');
    expect(stdout.value).toContain('"input"');
  });

  it("keeps first-run and doctor scoped to product tech when reference directories contain foreign projects", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-reference-scope-");
    await Promise.all([
      mkdir(path.join(project.root, "docs"), { recursive: true }),
      mkdir(path.join(project.root, "examples", "jvm"), { recursive: true }),
      mkdir(path.join(project.root, "fixtures", "rust"), { recursive: true }),
      mkdir(path.join(project.root, "reference", "python"), { recursive: true }),
      mkdir(path.join(project.root, "references", "go"), { recursive: true }),
      mkdir(path.join(project.root, "samples", "dotnet"), { recursive: true }),
      mkdir(path.join(project.root, "test-projects", "go"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(project.root, "docs", "example.py"), "print('reference only')\n", "utf8"),
      writeFile(path.join(project.root, "examples", "jvm", "pom.xml"), "<project />\n", "utf8"),
      writeFile(path.join(project.root, "fixtures", "rust", "Cargo.toml"), "[package]\n", "utf8"),
      writeFile(
        path.join(project.root, "reference", "python", "pyproject.toml"),
        "[project]\nname = 'reference'\n",
        "utf8",
      ),
      writeFile(
        path.join(project.root, "references", "go", "go.mod"),
        "module references\n",
        "utf8",
      ),
      writeFile(
        path.join(project.root, "samples", "dotnet", "Reference.csproj"),
        "<Project />\n",
        "utf8",
      ),
      writeFile(
        path.join(project.root, "test-projects", "go", "go.mod"),
        "module reference\n",
        "utf8",
      ),
    ]);

    const doctorStdout = new MemoryOutput();
    const doctorStderr = new MemoryOutput();
    const doctorExitCode = await runCli(
      ["node", "aiq", "doctor", "--stage", "typecheck", "--format", "json"],
      {
        cwd: project.root,
        stderr: doctorStderr,
        stdin: new MemoryInput(),
        stdout: doctorStdout,
      },
    );

    expect(doctorExitCode).toBe(0);
    expect(doctorStderr.value).toBe("");
    const doctorOutput = JSON.parse(doctorStdout.value) as { detectedTech: string[]; ok: boolean };
    expect(doctorOutput.ok).toBe(true);
    expect(doctorOutput.detectedTech).toEqual(["TypeScript"]);

    const firstRunStdout = new MemoryOutput();
    const firstRunStderr = new MemoryOutput();
    const firstRunExitCode = await runCli(
      ["node", "aiq", "--stage", "typecheck", "--dry-run", "--format", "json"],
      {
        cwd: project.root,
        stderr: firstRunStderr,
        stdin: new MemoryInput(),
        stdout: firstRunStdout,
      },
    );

    expect(firstRunExitCode).toBe(0);
    expect(firstRunStderr.value).toBe("");
    expect(firstRunStdout.value).toContain('"detectedProjects"');
    expect(firstRunStdout.value).toContain('"dryRun": true');
    expect(firstRunStdout.value).toContain('"typecheck"');
    expect(firstRunStdout.value).not.toContain("example.py");
    expect(firstRunStdout.value).not.toContain("pom.xml");
    expect(firstRunStdout.value).not.toContain("Cargo.toml");
    expect(firstRunStdout.value).not.toContain("pyproject.toml");
    expect(firstRunStdout.value).not.toContain("Reference.csproj");
    expect(firstRunStdout.value).not.toContain("go.mod");
  });

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
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
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
    expect(stdout.value).toContain("- typecheck: failed");
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

  it("treats an existing extensionless first token as an implicit run path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-extensionless-path-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "LICENSE"), "AIQ fixture\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "LICENSE", "--stage", "e2e", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      request: { manifest: { files: string[] }; selection: { stages: string[] } };
    };
    expect(output.request.manifest.files).toEqual([path.join(tempDir, "LICENSE")]);
    expect(output.request.selection.stages).toEqual(["e2e"]);
  });

  it("treats a leading file path as an implicit run command", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", fixtureFile, "--stage", "typecheck"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Status: passed");
    expect(stdout.value).toContain("- typecheck: passed");
  });

  it("runs explicit target output with the run label", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", fixtureFile, "--stage", "typecheck"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Status: passed");
    expect(stdout.value).toContain("- typecheck: passed");
  });

  it("runs explicit check output with the check label", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", fixtureFile, "--stage", "typecheck"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ check");
    expect(stdout.value).toContain("Status: passed");
    expect(stdout.value).toContain("- typecheck: passed");
  });

  it("supports run --up-to stage shortcuts using the published stage ladder", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--up-to", "0", "--format", "json"],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      request: { selection: { stages: string[] } };
      stages: Array<{
        diagnostics: Array<{ source: string }>;
        stageId: string;
        status: string;
      }>;
    };
    expect(output.request.selection.stages).toEqual(["e2e"]);
    expect(output.stages).toMatchObject([{ stageId: "e2e", status: "failed" }]);
    expect(output.stages[0]?.diagnostics[0]?.source).toBe("aiq-e2e");
  });

  it("runs cumulative stages for run --up-to stage shortcuts", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--up-to", "3", "--dry-run", "--format", "json"],
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
      plan: { stages: string[] };
    };
    expect(output.plan.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
  });

  it("supports run --only stage shortcuts using the published stage ladder", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--only", "3", "--format", "json"],
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
      request: { selection: { stages: string[] } };
      stages: Array<{ stageId: string }>;
    };
    expect(output.request.selection.stages).toEqual(["typecheck"]);
    expect(output.stages.map((stage) => stage.stageId)).toEqual(["typecheck"]);
  });

  it("rejects out-of-range stage shortcut flags with usage code", async () => {
    for (const argv of [
      ["node", "aiq", "run", fixtureFile, "--only", "10"],
      ["node", "aiq", "run", fixtureFile, "--up-to", "10"],
    ]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("must be between 0 and 9");
    }
  });

  it("prints a dry-run plan without executing tools or writing artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-dry-run-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        fixtureFile,
        "--stage",
        "lint",
        "--dry-run",
        "--out-dir",
        tempDir,
        "--format",
        "json",
      ],
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
      dryRun: boolean;
      plan: { stages: string[]; tasks: Array<{ stageId: string }> };
    };
    expect(output.dryRun).toBe(true);
    expect(output.plan.stages).toEqual(["lint"]);
    expect(output.plan.tasks).toMatchObject([{ stageId: "lint" }]);
    await expect(access(path.join(tempDir, "aiq.plan.json"))).rejects.toThrow();
    await expect(access(path.join(tempDir, "aiq.report.json"))).rejects.toThrow();
  });

  it("adds verbose command details to text run output", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", fixtureFile, "--stage", "typecheck", "--verbose"],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ run");
    expect(stdout.value).toContain("Verbose tool details:");
    expect(stdout.value).toContain("- typecheck: tsc");
    expect(stdout.value).toContain("status=passed");
  });

  it("records diff-only intent and keeps safe stages scoped to the changed manifest", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        fixtureFile,
        "--stage",
        "lint",
        "--stage",
        "sloc",
        "--diff-only",
        "--dry-run",
        "--format",
        "json",
      ],
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
      plan: {
        input: { files: string[] };
        request?: unknown;
        tasks: Array<{ files: string[]; stageId: string }>;
      };
    };
    expect(output.plan.input.files).toContain(fixtureFile);
    expect(output.plan.tasks).toEqual([
      expect.objectContaining({ files: [fixtureFile], stageId: "lint" }),
      expect.objectContaining({ files: [fixtureFile], stageId: "sloc" }),
    ]);
  });

  it("keeps full-run stages selected under diff-only without narrowing to safe-stage behavior", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-diff-only-full-stage-");
    const siblingFile = path.join(project.root, "src", "sibling.ts");
    await writeFile(siblingFile, "export const sibling = 2;\n", "utf8");
    await initializeGitRepository(project.root);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        "--stage",
        "lint",
        "--stage",
        "typecheck",
        "--diff-only",
        "--dry-run",
        "--format",
        "json",
      ],
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
      plan: { tasks: Array<{ files: string[]; stageId: string }> };
    };
    const changedFile = path.join(project.root, "src", "index.ts");
    const lintTask = output.plan.tasks.find((task) => task.stageId === "lint");
    const typecheckTask = output.plan.tasks.find((task) => task.stageId === "typecheck");
    expect(lintTask?.files).toEqual([changedFile]);
    expect(typecheckTask?.files).toContain(changedFile);
    expect(typecheckTask?.files).toContain(path.join(project.root, "tsconfig.json"));
    expect(typecheckTask?.files).toContain(siblingFile);
  });

  it("uses changed files only for every diff-only safe stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-diff-only-safe-matrix-");
    const siblingFile = path.join(project.root, "src", "sibling.ts");
    await writeFile(siblingFile, "export const sibling = 2;\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const safeStages = ["lint", "format", "sloc", "complexity", "maintainability"];

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        ...safeStages.flatMap((stage) => ["--stage", stage]),
        "--diff-only",
        "--dry-run",
        "--format",
        "json",
      ],
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
      plan: { tasks: Array<{ files: string[]; stageId: string }> };
    };
    const changedFile = path.join(project.root, "src", "index.ts");
    for (const stage of safeStages) {
      expect(output.plan.tasks.find((task) => task.stageId === stage)?.files).toEqual([
        changedFile,
      ]);
    }
  });

  it("uses workspace files for every full-run stage under diff-only", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-diff-only-full-matrix-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    const changedFile = path.join(tempDir, "src", "index.ts");
    const siblingFile = path.join(tempDir, "src", "sibling.ts");
    await writeFile(changedFile, "export const value = 1;\n", "utf8");
    await writeFile(siblingFile, "export const sibling = 2;\n", "utf8");
    await initializeGitRepository(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const fullStages = ["e2e", "typecheck", "unit", "coverage", "security"];

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        ...fullStages.flatMap((stage) => ["--stage", stage]),
        "--diff-only",
        "--dry-run",
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

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      plan: { tasks: Array<{ files: string[]; stageId: string }> };
    };
    for (const stage of fullStages) {
      const files = output.plan.tasks.find((task) => task.stageId === stage)?.files;
      expect(files).toContain(changedFile);
      expect(files).toContain(siblingFile);
    }
  });

  it("fails fast when diff-only full-run stages cannot enumerate a Git workspace", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-diff-only-no-git-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--stage", "typecheck", "--diff-only", "--dry-run"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("--diff-only full-run stages require Git workspace enumeration");
  });

  it("reports doctor checks and universal optional prerequisites in human-readable form", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-doctor-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "doctor"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ doctor");
    expect(stdout.value).toContain("Config:");
    expect(stdout.value).toContain("Progress:");
    expect(stdout.value).toContain("Technologies:");
    expect(stdout.value).toContain("Node.js runtime");
    expect(stdout.value).toContain("Status:");
    expect(stdout.value).not.toContain("OK Git - not detected");
  });

  it("reports optional universal doctor prerequisites without failing the command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-doctor-missing-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "doctor", "--format", "json"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      const output = JSON.parse(stdout.value) as {
        checks: Array<{
          detail?: string;
          name: string;
          ok: boolean;
          required?: boolean;
          source?: string;
        }>;
        detectedTech: string[];
        ok: boolean;
      };
      expect(output.ok).toBe(true);
      expect(output.detectedTech).toEqual([]);
      expect(output.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Node.js runtime", ok: true }),
          expect.objectContaining({ name: "npm package manager", ok: true }),
          expect.objectContaining({ name: "Git", ok: true }),
        ]),
      );
      expect(output.checks.find((check) => check.name === "Git")).toMatchObject({
        detail: expect.stringContaining("not detected"),
        required: false,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("uses persisted current_stage and reports detected technology setup", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-doctor-progress-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "doctor", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      checks: Array<{ name: string; ok: boolean; source?: string }>;
      detectedTech: string[];
      stages: string[];
    };
    expect(output.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(output.detectedTech).toEqual(["TypeScript"]);
    expect(output.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Biome JS/TS lint/format tool", source: "bundled" }),
        expect.objectContaining({ name: "TypeScript compiler", source: "bundled" }),
      ]),
    );
  });

  it("accepts explicit doctor stage targeting flags", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-doctor-stage-targets-");

    const cases: Array<{ args: string[]; stages: string[] }> = [
      { args: ["--up-to", "3"], stages: ["e2e", "lint", "format", "typecheck"] },
      { args: ["--only", "1"], stages: ["lint"] },
      { args: ["--stage", "typecheck"], stages: ["typecheck"] },
      { args: ["--profile", "standard"], stages: ["lint", "typecheck", "unit"] },
    ];

    for (const testCase of cases) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await runCli(
        ["node", "aiq", "doctor", ...testCase.args, "--format", "json"],
        {
          cwd: project.root,
          stderr,
          stdin: new MemoryInput(),
          stdout,
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      const output = JSON.parse(stdout.value) as { stages: string[] };
      expect(output.stages).toEqual(testCase.stages);
    }
  });

  it("fails doctor when detected selected tech is missing required host tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-doctor-python-missing-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "main.py"), "print('hello')\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        ["node", "aiq", "doctor", "--stage", "typecheck", "--format", "json"],
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
        checks: Array<{ detail?: string; name: string; ok: boolean; required?: boolean }>;
        detectedTech: string[];
        ok: boolean;
      };
      expect(output.ok).toBe(false);
      expect(output.detectedTech).toEqual(["Python"]);
      expect(output.checks.find((check) => check.name === "Python runtime")).toMatchObject({
        detail: expect.stringContaining("Install Python 3"),
        ok: false,
        required: true,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

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

  it("initializes canonical config and progress files with aiq config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-init-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ config initialized");
    expect(stdout.value).toContain(path.join(tempDir, ".aiq", "aiq.config.json"));
    expect(stdout.value).toContain(path.join(tempDir, ".aiq", "progress.json"));

    const config = JSON.parse(
      await readFile(path.join(tempDir, ".aiq", "aiq.config.json"), "utf8"),
    ) as { version: number };
    const progress = JSON.parse(
      await readFile(path.join(tempDir, ".aiq", "progress.json"), "utf8"),
    ) as { current_stage: number; disabled: number[]; last_run: string | null; order: number[] };
    expect(config).toEqual({ version: 1 });
    expect(progress).toEqual({
      current_stage: 1,
      disabled: [],
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      last_run: null,
    });
  });

  it("fails fast when aiq config finds malformed existing config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-invalid-init-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await writeFile(path.join(tempDir, ".aiq", "aiq.config.json"), '{"version":1,}\n', "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Failed to parse");
  });

  it("prints effective config with persisted progress state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-print-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await writeFile(path.join(tempDir, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config", "--print-config", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      config: { version: number };
      progress: { current_stage: number; order: number[] };
      progressSource: string;
      profile: string;
      stages: string[];
    };
    expect(output.config.version).toBe(1);
    expect(output.progress.current_stage).toBe(3);
    expect(output.progress.order).toEqual([0, 1, 2, 3]);
    expect(output.progressSource).toBe("file");
    expect(output.profile).toBe("fast");
    expect(output.stages).toEqual(["lint"]);
  });

  it("persists current_stage with aiq config --set-stage", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-set-stage-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config", "--set-stage", "6"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Set current_stage=6");

    const progress = JSON.parse(
      await readFile(path.join(tempDir, ".aiq", "progress.json"), "utf8"),
    ) as { current_stage: number; order: number[] };
    expect(progress.current_stage).toBe(6);
    expect(progress.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("rejects invalid aiq config --set-stage values", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config", "--set-stage", "10"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("--set-stage must be between 0 and 9");
  });

  it("rejects non-config flags on aiq config", async () => {
    for (const argv of [
      ["node", "aiq", "config", "--scenario", "smoke"],
      ["node", "aiq", "config", "--tag", "ci"],
      ["node", "aiq", "config", "--kind", "warm"],
      ["node", "aiq", "config", "--corpus-root", "fixtures"],
      ["node", "aiq", "config", "--host", "0.0.0.0"],
      ["node", "aiq", "config", "--port", "0"],
      ["node", "aiq", "config", "--debounce-ms", "5"],
    ]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain(
        "The config command only accepts --print-config, --set-stage, and --format options.",
      );
    }
  });

  it("uses persisted current_stage as the default cumulative run target", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-run-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(path.join(project.root, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      request: { selection: { stages: string[] } };
      stages: Array<{ stageId: string }>;
      workflow: {
        currentStage: { id: string; index: number };
        defaultRun: { range: string };
        nextCommand: string;
        selectedStages: string[];
      };
    };
    expect(output.request.selection.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(output.stages.map((stage) => stage.stageId)).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
    ]);
    expect(output.workflow).toMatchObject({
      currentStage: { id: "typecheck", index: 3 },
      defaultRun: {
        range: "0..3",
      },
      nextCommand: "aiq run <paths...> --only 0 --verbose",
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
  });

  it("reports progress default stages when workflow requests omit explicit stages", () => {
    const workflow = createRunWorkflowOutput(
      {
        path: "/tmp/project/.aiq/progress.json",
        progress: {
          current_stage: 3,
          disabled: [],
          last_run: null,
          order: [0, 1, 2, 3],
        },
        source: "file",
      },
      {
        stages: undefined,
      } as RunRequest,
      {
        stages: [],
        summary: {
          status: "passed",
        },
      } as RunResult,
    );

    expect(workflow.selectedStages).toEqual(["e2e", "lint", "format", "typecheck"]);
  });

  it("reports status before any run without writing config state", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-status-no-run-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    const progressPath = path.join(project.root, ".aiq", "progress.json");
    const progressContents = `${JSON.stringify({
      current_stage: 3,
      disabled: [],
      order: [0, 1, 2, 3],
      last_run: "previous",
    })}\n`;
    await writeFile(progressPath, progressContents, "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "status", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      artifactPaths: { plan: string; report: string };
      currentStage: { id: string; index: number };
      defaultRun: { range: string; stages: Array<{ id: string }> };
      lastRun: { failedStages: unknown[]; status: string };
      nextCommand: string;
      progressLastRun: string | null;
      selectedStages: string[];
    };
    expect(output.currentStage).toMatchObject({ id: "typecheck", index: 3 });
    expect(output.defaultRun.range).toBe("0..3");
    expect(output.defaultRun.stages.map((stage) => stage.id)).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
    ]);
    expect(output.selectedStages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(output.lastRun).toMatchObject({ failedStages: [], status: "none" });
    expect(output.progressLastRun).toBe("previous");
    expect(output.nextCommand).toBe("aiq run <paths...>");
    expect(output.artifactPaths.report).toBe(
      path.join(project.root, ".aiq", "out", "aiq.report.json"),
    );
    expect(await readFile(progressPath, "utf8")).toBe(progressContents);
    await expect(access(path.join(project.root, ".aiq", "aiq.config.json"))).rejects.toThrow();
  });

  it("emits trusted missing-quality evidence before any run", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-evidence-no-run-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const evidence = JSON.parse(stdout.value) as {
      reasonCode: string;
      result: string;
      schemaVersion: number;
      states: Array<{
        value: {
          kind: string;
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
      trust: string;
    };
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.result).toBe("missing");
    expect(evidence.reasonCode).toBe("missing-evidence");
    expect(evidence.trust).toBe("local-evidence");
    expect(evidence.states[0]?.value).toMatchObject({
      kind: "quality",
      lastRunStatus: "missing",
      ready: true,
      status: "fail",
    });
    expect(evidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "missing-report",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: stdout.value,
    });
    expect(trustedState.ok).toBe(true);
    if (trustedState.ok) {
      expect(trustedState.states[0]?.value.kind).toBe("quality");
      expect(trustedState.states[0]?.value.status).toBe("fail");
    }
  });

  it("emits trusted malformed-quality evidence for invalid report shapes", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-evidence-malformed-run-");
    const reportDir = path.join(project.root, ".aiq", "out");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "aiq.report.json"),
      `${JSON.stringify({
        artifactType: "report",
        finishedAt: new Date().toISOString(),
        runId: "run-invalid",
        summary: { status: "failed" },
        stages: [
          {
            stageId: "typecheck",
            status: "failed",
            diagnostics: [{ file: 42, message: "bad diagnostic", severity: "error" }],
          },
        ],
        request: { manifest: { files: ["src/index.ts"] } },
      })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const evidence = JSON.parse(stdout.value) as {
      reasonCode: string;
      result: string;
      states: Array<{
        value: {
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
    };
    expect(evidence.result).toBe("failed");
    expect(evidence.reasonCode).toBe("malformed-evidence");
    expect(evidence.states[0]?.value).toMatchObject({
      lastRunStatus: "malformed",
      ready: true,
      status: "fail",
    });
    expect(evidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "malformed-report",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: stdout.value,
    });
    expect(trustedState.ok).toBe(true);
  });

  it("prints focused failed-stage workflow guidance and records failed status", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-status-failed-run-");
    await writeFile(project.filePath, "export const value: string = 1;\n", "utf8");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(path.join(project.root, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts", "--only", "3"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ workflow");
    expect(stdout.value).toContain("Current stage: 3 typecheck");
    expect(stdout.value).toContain("Default run: stages 0..3 (e2e, lint, format, typecheck)");
    expect(stdout.value).toContain("Selected stages: typecheck");
    expect(stdout.value).toContain("Debug 3 typecheck: aiq run <paths...> --only 3 --verbose");

    const statusStdout = new MemoryOutput();
    const statusStderr = new MemoryOutput();
    const statusExitCode = await runCli(["node", "aiq", "status", "--format", "json"], {
      cwd: project.root,
      stderr: statusStderr,
      stdin: new MemoryInput(),
      stdout: statusStdout,
    });

    expect(statusExitCode).toBe(0);
    expect(statusStderr.value).toBe("");
    const status = JSON.parse(statusStdout.value) as {
      lastRun: { failedStages: Array<{ id: string; index: number }>; status: string };
      nextCommand: string;
    };
    expect(status.lastRun.status).toBe("failed");
    expect(status.lastRun.failedStages).toEqual([{ id: "typecheck", index: 3, name: "typecheck" }]);
    expect(status.nextCommand).toBe("aiq run <paths...> --only 3 --verbose");

    const evidenceStdout = new MemoryOutput();
    const evidenceStderr = new MemoryOutput();
    const evidenceExitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr: evidenceStderr,
      stdin: new MemoryInput(),
      stdout: evidenceStdout,
    });

    expect(evidenceExitCode).toBe(0);
    expect(evidenceStderr.value).toBe("");
    const evidence = JSON.parse(evidenceStdout.value) as {
      result: string;
      states: Array<{
        value: {
          failingChecks: string[];
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
    };
    expect(evidence.result).toBe("failed");
    expect(evidence.states[0]?.value).toMatchObject({
      failingChecks: ["typecheck"],
      lastRunStatus: "fail",
      ready: true,
      status: "fail",
    });
    expect(evidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "typecheck",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: evidenceStdout.value,
    });
    expect(trustedState.ok).toBe(true);
  });

  it("prints successful current-stage workflow guidance and advancement", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-status-successful-run-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(path.join(project.root, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts", "--only", "3"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Current stage satisfied: yes (3 typecheck)");
    expect(stdout.value).toContain("Advance: aiq config --set-stage 4");

    const evidenceStdout = new MemoryOutput();
    const evidenceStderr = new MemoryOutput();
    const evidenceExitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr: evidenceStderr,
      stdin: new MemoryInput(),
      stdout: evidenceStdout,
    });

    expect(evidenceExitCode).toBe(0);
    expect(evidenceStderr.value).toBe("");
    const evidence = JSON.parse(evidenceStdout.value) as {
      result: string;
      stale: boolean;
      states: Array<{
        value: {
          lastRunStatus: string;
          ready: boolean;
          status: string;
        };
      }>;
    };
    expect(evidence.result).toBe("passed");
    expect(evidence.stale).toBe(false);
    expect(evidence.states[0]?.value).toMatchObject({
      lastRunStatus: "pass",
      ready: false,
      status: "pass",
    });

    const reportPath = path.join(project.root, ".aiq", "out", "aiq.report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as { finishedAt: string };
    report.finishedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const staleStdout = new MemoryOutput();
    const staleStderr = new MemoryOutput();
    const staleExitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr: staleStderr,
      stdin: new MemoryInput(),
      stdout: staleStdout,
    });

    expect(staleExitCode).toBe(0);
    expect(staleStderr.value).toBe("");
    const staleEvidence = JSON.parse(staleStdout.value) as {
      reasonCode: string;
      result: string;
      stale: boolean;
      states: Array<{
        value: {
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
    };
    expect(staleEvidence.result).toBe("stale");
    expect(staleEvidence.reasonCode).toBe("stale-evidence");
    expect(staleEvidence.stale).toBe(true);
    expect(staleEvidence.states[0]?.value).toMatchObject({
      lastRunStatus: "stale",
      ready: true,
      status: "fail",
    });
    expect(staleEvidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "stale-report",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: staleStdout.value,
    });
    expect(trustedState.ok).toBe(true);

    const statusStdout = new MemoryOutput();
    const statusStderr = new MemoryOutput();
    const statusExitCode = await runCli(["node", "aiq", "status"], {
      cwd: project.root,
      stderr: statusStderr,
      stdin: new MemoryInput(),
      stdout: statusStdout,
    });

    expect(statusExitCode).toBe(0);
    expect(statusStderr.value).toBe("");
    expect(statusStdout.value).toContain("Last run: passed");
    expect(statusStdout.value).toContain("Next: aiq config --set-stage 4");
  });

  it("uses persisted current_stage as the default cumulative check target", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-check-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "src/index.ts", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      request: { selection: { stages: string[] } };
    };
    expect(output.request.selection.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
  });

  it("lets explicit run stage flags override persisted current_stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-override-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "--only", "1", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as { request: { selection: { stages: string[] } } };
    expect(output.request.selection.stages).toEqual(["lint"]);
  });

  it("lets explicit run profiles override persisted current_stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-profile-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        "--profile",
        "standard",
        "--dry-run",
        "--format",
        "json",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as { plan: { stages: string[] } };
    expect(output.plan.stages).toEqual(["lint", "typecheck", "unit"]);
  });

  it("lets explicit named run stages override persisted current_stage", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-named-stage-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "run",
        "src/index.ts",
        "--stage",
        "security",
        "--dry-run",
        "--format",
        "json",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as { plan: { stages: string[] } };
    expect(output.plan.stages).toEqual(["security"]);
  });

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

  it.each([12, -1])("fails fast on malformed progress stage %i", async (currentStage) => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-invalid-");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: currentStage, disabled: [], order: [0], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("current_stage must be a stage index from 0 to 9");
  });

  it("fails with usage code when a positional input file does not exist", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "missing-cli-input.ts"], {
      cwd: process.cwd(),
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
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(
      ["node", "aiq", "check", "--files", "missing-cli-flag-input.ts"],
      {
        cwd: process.cwd(),
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
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "check", "--files-from", "missing-files.txt"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("File list not found:");
    expect(stderr.value).toContain("missing-files.txt");
  });

  it("fails with usage code when watch startup inputs do not resolve", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    await expect(
      runCli(["node", "aiq", "watch", "missing-watch-input.ts"], {
        cwd: process.cwd(),
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
    for (const argv of [
      ["node", "aiq", "serve", "--port", "3000abc"],
      ["node", "aiq", "watch", "src/index.ts", "--debounce-ms", "40ms"],
    ]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("must be a non-negative integer");
    }
  });

  it("accepts --port 0 for ephemeral serve ports", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-port-zero-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    expect(listening.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("formats IPv6 serve URLs with brackets", () => {
    const stdout = new MemoryOutput();

    writeServeListeningOutput(
      {
        cwd: process.cwd(),
        stderr: new MemoryOutput(),
        stdin: new MemoryInput(),
        stdout,
      },
      "json",
      "::1",
      4317,
    );

    expect(
      parseJsonLines<{ event: string; host: string; port: number; url: string }>(stdout.value),
    ).toMatchObject([
      {
        event: "listening",
        host: "::1",
        port: 4317,
        url: "http://[::1]:4317",
      },
    ]);
  });

  it("renders benchmark output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-bench-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "bench",
        "--scenario",
        "javascript-lint-single-file-cold",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
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
      artifactType: string;
      primaryMetric: { field: string; goal: string; unit: string; value: number };
      scenarios: Array<{
        id: string;
        kind: string;
        manifest: { fileCount: number; shape: string };
      }>;
      selection: { matchedScenarioCount: number; scenarioIds: string[] };
      summary: { failedBudgetCount: number; scenarioCount: number };
    };
    expect(output.artifactType).toBe("benchmark");
    expect(output.primaryMetric).toMatchObject({
      field: "summary.totalDurationMs",
      goal: "minimize",
      unit: "ms",
    });
    expect(output.selection).toMatchObject({
      matchedScenarioCount: 1,
      scenarioIds: ["javascript-lint-single-file-cold"],
    });
    expect(output.summary.failedBudgetCount).toBe(0);
    expect(output.summary.scenarioCount).toBe(1);
    expect(output.scenarios[0]).toMatchObject({
      id: "javascript-lint-single-file-cold",
      kind: "cold",
      manifest: {
        fileCount: 1,
        shape: "single-file",
      },
    });

    const artifactJson = JSON.parse(
      await readFile(path.join(tempDir, "aiq.benchmark.json"), "utf8"),
    ) as { artifactType: string };
    expect(artifactJson.artifactType).toBe("benchmark");
  });

  it("renders check output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        "test-projects/typescript/src/lint-failure.ts",
        "--stage",
        "lint",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      stages: Array<{
        diagnostics: Array<{ file: string; source: string }>;
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      request: { context: string; outDir: string };
      summary: {
        diagnosticCount: number;
        fileCount: number;
        notImplementedStageCount: number;
        status: string;
      };
    };
    expect(output.artifactType).toBe("report");
    expect(output.artifacts.outDir).toBe(tempDir);
    expect(output.context).toBe("cli");
    expect(output.request.context).toBe("cli");
    expect(output.request.outDir).toBe(tempDir);
    expect(output.summary.diagnosticCount).toBeGreaterThan(0);
    expect(output.summary.fileCount).toBe(1);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("failed");
    expect(output.stages[0]).toMatchObject({
      stageId: "lint",
      status: "failed",
    });
    expect(output.stages[0]?.diagnostics[0]).toMatchObject({
      file: lintFailureFixtureFile,
      source: "biome",
    });
    expect(output.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "biome",
    });

    const reportJson = JSON.parse(
      await readFile(path.join(tempDir, "aiq.report.json"), "utf8"),
    ) as {
      artifactType: string;
    };
    expect(reportJson.artifactType).toBe("report");
  });

  it("renders passing typecheck output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-typecheck-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixtureFile,
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
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
      stages: Array<{
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages[0]).toMatchObject({
      stageId: "typecheck",
      status: "passed",
    });
    expect(output.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "tsc",
    });
  });

  it("renders passing unit output as JSON for JavaScript and TypeScript projects", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-unit-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixtureFile,
        fixtureJavaScriptFile,
        "--stage",
        "unit",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
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
      stages: Array<{
        notes: string[];
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages[0]).toMatchObject({
      stageId: "unit",
      status: "passed",
    });
    expect(output.stages[0]?.notes.join(" ")).toContain("Vitest ran");
    expect(output.stages[0]?.notes.join(" ")).toContain("Jest ran");
    expect(output.stages[0]?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "jest" }),
      ]),
    );
  });

  it("renders coverage output as JSON for JavaScript and TypeScript fixtures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-coverage-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixtureFile,
        fixtureJavaScriptFile,
        "--stage",
        "coverage",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
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
      stages: Array<{
        notes: string[];
        stageId: string;
        status: string;
        toolRuns: Array<{ exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages[0]).toMatchObject({
      stageId: "coverage",
      status: "passed",
    });
    expect(output.stages[0]?.notes.join(" ")).toContain("Vitest coverage lines:");
    expect(output.stages[0]?.notes.join(" ")).toContain("Jest coverage lines:");
    expect(output.stages[0]?.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "jest" }),
      ]),
    );
  });

  it.skipIf(!hasPythonQualityToolchain)("renders passing Python output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-python-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        fixturePythonFile,
        "--stage",
        "lint",
        "--stage",
        "format",
        "--stage",
        "typecheck",
        "--stage",
        "unit",
        "--stage",
        "coverage",
        "--stage",
        "complexity",
        "--stage",
        "maintainability",
        "--stage",
        "security",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
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
      stages: Array<{
        notes: string[];
        stageId: string;
        status: string;
        toolRuns: Array<{ cacheHit?: boolean; exitCode?: number; status: string; tool: string }>;
      }>;
      summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
    };
    expect(output.summary.diagnosticCount).toBe(0);
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("passed");
    expect(output.stages).toHaveLength(8);
    expect(output.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "ruff",
    });
    expect(output.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
      "Pytest ran",
    );
    expect(output.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
      "Pytest coverage lines:",
    );
    expect(
      output.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
    ).toContain("Reused cached Python metrics");
    expect(
      output.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
    ).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "radon",
    });
  });

  it.skipIf(!hasDotNet10Toolchain)(
    "renders passing .NET output as JSON",
    async () => {
      const project = await createDotNetFixtureProject("aiq-cli-check-dotnet-");

      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await withExclusiveToolLock("dotnet", async () =>
        runCli(
          [
            "node",
            "aiq",
            "check",
            project.filePath,
            "--stage",
            "lint",
            "--stage",
            "format",
            "--stage",
            "typecheck",
            "--stage",
            "unit",
            "--stage",
            "coverage",
            "--stage",
            "complexity",
            "--stage",
            "maintainability",
            "--stage",
            "security",
            "--format",
            "json",
            "--out-dir",
            project.root,
          ],
          {
            cwd: project.root,
            stderr,
            stdin: new MemoryInput(),
            stdout,
          },
        ),
      );

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");

      const output = JSON.parse(stdout.value) as {
        stages: Array<{
          notes: string[];
          stageId: string;
          status: string;
          toolRuns: Array<{ cacheHit?: boolean; exitCode?: number; status: string; tool: string }>;
        }>;
        summary: { diagnosticCount: number; notImplementedStageCount: number; status: string };
      };
      expect(output.summary.diagnosticCount).toBe(0);
      expect(output.summary.notImplementedStageCount).toBe(0);
      expect(output.summary.status).toBe("passed");
      expect(output.stages).toHaveLength(8);
      expect(output.stages.find((stage) => stage.stageId === "lint")?.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-format-style",
      });
      expect(
        output.stages.find((stage) => stage.stageId === "typecheck")?.toolRuns[0],
      ).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "dotnet-build",
      });
      expect(output.stages.find((stage) => stage.stageId === "unit")?.notes[0]).toContain(
        "dotnet test ran",
      );
      expect(output.stages.find((stage) => stage.stageId === "coverage")?.notes[0]).toContain(
        "dotnet test coverage lines:",
      );
      expect(
        output.stages.find((stage) => stage.stageId === "maintainability")?.notes.join(" "),
      ).toContain("Reused cached C# metrics");
      expect(
        output.stages.find((stage) => stage.stageId === "maintainability")?.toolRuns[0],
      ).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "aiq-csharp-metrics",
      });
    },
    // Real .NET SDK restore/build/test/coverage/security can exceed 20s on cold local agents.
    90_000,
  );

  it("renders format diagnostics as JSON for JSONC inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-format-"));
    tempDirs.push(tempDir);
    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(jsoncFile, '{"name" :"typescript-fixture" ,"items" :[1,2,3]}\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        jsoncFile,
        "--stage",
        "format",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      stages: Array<{
        diagnostics: Array<{ file: string; source: string }>;
        stageId: string;
        status: string;
      }>;
      summary: { notImplementedStageCount: number; status: string };
    };
    expect(output.summary.notImplementedStageCount).toBe(0);
    expect(output.summary.status).toBe("failed");
    expect(output.stages[0]).toMatchObject({
      stageId: "format",
      status: "failed",
    });
    expect(output.stages[0]?.diagnostics[0]).toMatchObject({
      file: jsoncFile,
      source: "biome",
    });
  });

  it("renders check output as text from direct file input", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-text-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        "--files",
        lintFailureFixtureFile,
        "--stage",
        "lint",
        "--format",
        "text",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ check");
    expect(stdout.value).toContain("Not implemented: 0");
    expect(stdout.value).toContain("Status: failed");
    expect(stdout.value).toContain(
      `Artifacts: plan=${path.join(tempDir, "aiq.plan.json")}, report=${path.join(tempDir, "aiq.report.json")}`,
    );
    expect(stdout.value).toContain("- lint: failed");
    expect(stdout.value).toContain("Biome reported");
    expect(stdout.value).toContain("Quality failures:");
    expect(stdout.value).toContain("Suggested next commands:");
  });

  it("groups Python missing setup failures in text output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-python-missing-setup-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "main.py"), "print('hello')\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "run", "main.py", "--stage", "typecheck"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("Missing tools:");
      expect(stdout.value).toContain("[stage 3 typecheck]");
      expect(stdout.value).toContain("aiq setup");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("groups external-tool language setup failures in text output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-go-missing-lizard-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "go.mod"), "module example.com/aiq\n\ngo 1.22\n", "utf8");
    await writeFile(path.join(tempDir, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(["node", "aiq", "run", "main.go", "--stage", "sloc"], {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("Missing tools:");
      expect(stdout.value).toContain("[stage 5 sloc]");
      expect(stdout.value).toContain("lizard");
      expect(stdout.value).toContain("aiq setup");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps external missing-tool setup guidance in JSON output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-go-missing-lizard-json-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "go.mod"), "module example.com/aiq\n\ngo 1.22\n", "utf8");
    await writeFile(path.join(tempDir, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        ["node", "aiq", "run", "main.go", "--stage", "sloc", "--format", "json"],
        {
          cwd: tempDir,
          stderr,
          stdin: new MemoryInput(),
          stdout,
        },
      );

      const output = JSON.parse(stdout.value) as {
        stages: Array<{ diagnostics: Array<{ message: string; source: string }> }>;
      };
      const diagnostic = output.stages[0]?.diagnostics[0];

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      expect(diagnostic).toMatchObject({
        source: "lizard",
        message: expect.stringContaining("Run aiq setup"),
      });
      expect(diagnostic?.message).not.toContain("spawn");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("renders plan output from direct file input and the default artifact directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-default-out-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "--files", fixtureFile, "--stage", "lint", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const defaultOutDir = path.join(tempDir, ".aiq/out");
    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      input: { source: string; summary: { fileCount: number } };
      stages: string[];
    };
    expect(output.artifactType).toBe("plan");
    expect(output.artifacts.outDir).toBe(defaultOutDir);
    expect(output.context).toBe("cli");
    expect(output.input.source).toBe("direct");
    expect(output.input.summary.fileCount).toBe(1);
    expect(output.stages).toEqual(["lint"]);

    const planJson = JSON.parse(
      await readFile(path.join(defaultOutDir, "aiq.plan.json"), "utf8"),
    ) as {
      artifactType: string;
      artifacts: { outDir: string };
    };
    expect(planJson.artifactType).toBe("plan");
    expect(planJson.artifacts.outDir).toBe(defaultOutDir);
    await expect(access(path.join(defaultOutDir, "aiq.report.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("renders plan output from file-list inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-plan-"));
    tempDirs.push(tempDir);
    const fileListPath = path.join(tempDir, "files.txt");
    await writeFile(fileListPath, `${fixtureFile}\n`, "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        "--files-from",
        fileListPath,
        "--stage",
        "lint",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
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
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      stages: string[];
      input: { source: string; summary: { fileCount: number } };
    };
    expect(output.artifactType).toBe("plan");
    expect(output.artifacts.outDir).toBe(tempDir);
    expect(output.context).toBe("cli");
    expect(output.stages).toEqual(["lint"]);
    expect(output.input.source).toBe("file-list");
    expect(output.input.summary.fileCount).toBe(1);

    const planJson = JSON.parse(await readFile(path.join(tempDir, "aiq.plan.json"), "utf8")) as {
      artifactType: string;
    };
    expect(planJson.artifactType).toBe("plan");
  });

  it("resolves --files-from relative to the CLI cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-files-from-cwd-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/input.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(tempDir, "files.txt"), "src/input.ts\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "--files-from", "files.txt", "--stage", "lint", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      input: { files: string[]; source: string };
    };
    expect(output.input.source).toBe("file-list");
    expect(output.input.files).toEqual([path.join(tempDir, "src/input.ts")]);
  });

  it("uses repo config surface defaults for plan requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-surface-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            standard: {
              changedOnly: true,
              stages: ["lint", "unit"],
            },
          },
          surfaces: {
            cli: {
              profile: "standard",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "plan", "src/index.ts", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[]; profile: string };
    expect(output.profile).toBe("standard");
    expect(output.stages).toEqual(["lint", "unit"]);
  });

  it("uses persisted current_stage as the default cumulative plan target", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-plan-progress-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(tempDir, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 6, disabled: [], order: [0, 1, 2, 3, 4, 5, 6], last_run: null })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "plan", "src/index.ts", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[] };
    expect(output.stages).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
    ]);
  });

  it("walks up to parent config and lets invocation stages override it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-parent-"));
    tempDirs.push(tempDir);

    const nestedDir = path.join(tempDir, "packages", "app");
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(nestedDir, "src"), { recursive: true });
    await writeFile(path.join(nestedDir, "src/index.ts"), "export const nested = true;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            standard: {
              changedOnly: false,
              stages: ["lint", "unit"],
            },
          },
          surfaces: {
            cli: {
              profile: "standard",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "src/index.ts", "--stage", "security", "--format", "json"],
      {
        cwd: nestedDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[]; profile: string };
    expect(output.profile).toBe("standard");
    expect(output.stages).toEqual(["security"]);
  });

  it("lets invocation profile override the surface default profile", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-profile-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const profile = true;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            deep: {
              changedOnly: false,
              stages: ["security"],
            },
          },
          surfaces: {
            cli: {
              profile: "fast",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "plan", "src/index.ts", "--profile", "deep", "--format", "json"],
      {
        cwd: tempDir,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[]; profile: string };
    expect(output.profile).toBe("deep");
    expect(output.stages).toEqual(["security"]);
  });

  it("deduplicates repeated invocation stages", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        fixtureFile,
        "--stage",
        "lint",
        "--stage",
        "lint",
        "--stage",
        "security",
        "--format",
        "json",
      ],
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
      stages: string[];
      tasks: Array<{ stageId: string }>;
    };
    expect(output.stages).toEqual(["lint", "security"]);
    expect(output.tasks.map((task) => task.stageId)).toEqual(["lint", "security"]);
  });

  it("fails fast when repo config is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-invalid-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const invalid = false;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "aiq.config.json"),
      '{"version":1,"surfaces":{"cli":{"profile":"broken"}}}\n',
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "plan", "src/index.ts", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("profile must be one of fast, standard, deep");
  });

  it("renders plan text output with the resolved artifact target", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-text-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        fixtureFile,
        "--stage",
        "lint",
        "--format",
        "text",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain(`Artifact target: ${tempDir}`);
    expect(stdout.value).toContain("Source: direct");
  });

  it("renders plan output from streamed file lists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-stream-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "plan",
        "--stdin-file-list",
        "--stage",
        "lint",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput("test-projects/typescript/src/lint-failure.ts\n"),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      artifacts: { outDir: string };
      context: string;
      stages: string[];
      input: { source: string; summary: { fileCount: number } };
    };
    expect(output.artifactType).toBe("plan");
    expect(output.artifacts.outDir).toBe(tempDir);
    expect(output.context).toBe("cli");
    expect(output.stages).toEqual(["lint"]);
    expect(output.input.source).toBe("stream");
    expect(output.input.summary.fileCount).toBe(1);
  });

  it("renders check output from streamed file lists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-check-stream-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "check",
        "--stdin-file-list",
        "--stage",
        "lint",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput("test-projects/typescript/src/lint-failure.ts\n"),
        stdout,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      request: { manifest: { source: string; summary: { fileCount: number } } };
    };
    expect(output.artifactType).toBe("report");
    expect(output.request.manifest.source).toBe("stream");
    expect(output.request.manifest.summary.fileCount).toBe(1);
  });

  it("reruns watch on fixture changes and exits with the last run status", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      [
        "node",
        "aiq",
        "watch",
        "src/index.ts",
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "40",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const firstRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean; request: { context: string } };
      }>(stdout.value);
      return lines.find((line) => line.event === "run");
    });

    expect(firstRun.result.ok).toBe(true);
    expect(firstRun.result.request.context).toBe("watch");

    await writeFile(
      project.filePath,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );

    const secondRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean; request: { context: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.length >= 2 ? lines[1] : undefined;
    });

    expect(secondRun.result.ok).toBe(false);
    expect(secondRun.result.request.context).toBe("watch");
    expect(secondRun.trigger).toContain(path.join("src", "index.ts"));
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(1);
  }, 15_000);

  it("coalesces rapid watch changes into one rerun", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-burst-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      [
        "node",
        "aiq",
        "watch",
        "src/index.ts",
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "120",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    await waitFor(() => {
      const lines = parseJsonLines<{ event: string }>(stdout.value).filter(
        (line) => line.event === "run",
      );
      return lines.length >= 1 ? lines[0] : undefined;
    });

    await writeFile(
      project.filePath,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );
    await writeFile(project.filePath, "export const value = 2;\n", "utf8");

    const secondRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean };
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.length >= 2 ? lines[1] : undefined;
    });

    expect(secondRun.result.ok).toBe(true);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(
      parseJsonLines<{ event: string }>(stdout.value).filter((line) => line.event === "run"),
    ).toHaveLength(2);
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  }, 10_000);

  it("supports watch cadence stages and only replans when config changes", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-cadence-");
    const configDir = path.join(project.root, ".aiq");
    const configPath = path.join(configDir, "aiq.config.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          surfaces: {
            watch: {
              cadenceMs: 150,
              cadenceStages: ["typecheck"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      [
        "node",
        "aiq",
        "watch",
        "src/index.ts",
        "--stage",
        "lint",
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "20",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const startupRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines[0];
    });

    expect(startupRun.trigger).toBe("startup");
    expect(startupRun.result.plan.stages).toEqual(["lint"]);

    const cadenceRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.find((line) => line.trigger === "cadence");
    });

    expect(cadenceRun.result.plan.stages).toEqual(["typecheck"]);
    expect(cadenceRun.result.plan.runId).not.toBe(startupRun.result.plan.runId);

    await writeFile(project.filePath, "export const value = 2;\n", "utf8");

    const fileChangeRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.find((line) => line.trigger.endsWith(path.join("src", "index.ts")));
    });

    expect(fileChangeRun.result.plan.stages).toEqual(["lint"]);
    expect(fileChangeRun.result.plan.runId).toBe(startupRun.result.plan.runId);

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          surfaces: {
            watch: {
              cadenceMs: 150,
              cadenceStages: [],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const configRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.find(
        (line) =>
          line.trigger.endsWith(path.join(".aiq", "aiq.config.json")) &&
          line.result.plan.runId !== startupRun.result.plan.runId,
      );
    });

    expect(configRun.result.plan.stages).toEqual(["lint", "typecheck"]);
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("serves run requests with structured JSON and shuts down cleanly", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const healthResponse = await fetch(`${listening.url}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({ ok: true });

    const runResponse = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({
        manifest: {
          files: ["src/index.ts"],
        },
        stages: ["typecheck"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(runResponse.status).toBe(200);
    await expect(runResponse.json()).resolves.toMatchObject({
      context: "serve",
      ok: true,
      request: {
        context: "serve",
      },
      summary: {
        status: "passed",
      },
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("rejects concurrent serve requests and releases the lock on client abort", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-lock-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const blockingRequest = httpRequest(`${listening.url}/run`, {
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    blockingRequest.on("error", () => undefined);
    blockingRequest.write('{"manifest":{"files":["src/index.ts"]},"stages":["typecheck"]');

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const busyResponse = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({
        manifest: {
          files: ["src/index.ts"],
        },
        stages: ["typecheck"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(busyResponse.status).toBe(503);
    await expect(busyResponse.json()).resolves.toEqual({
      error: "AIQ serve is already processing another run.",
    });

    blockingRequest.destroy();

    const recoveredResponse = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({
        manifest: {
          files: ["src/index.ts"],
        },
        stages: ["typecheck"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(recoveredResponse.status).toBe(200);
    await expect(recoveredResponse.json()).resolves.toMatchObject({
      context: "serve",
      request: {
        context: "serve",
      },
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("rejects invalid serve requests with a 400 response", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-invalid-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const response = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({ manifest: { files: [""] } }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "manifest.files[0] must be a non-empty string.",
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("rejects oversized serve request bodies with a 413 response", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-oversized-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const oversizedRequest = httpRequest(`${listening.url}/run`, {
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    const oversizedResponse = new Promise<{
      headers: IncomingHttpHeaders;
      payload: { error: string };
      statusCode: number;
    }>((resolve, reject) => {
      oversizedRequest.on("response", (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({
              headers: incoming.headers,
              payload: JSON.parse(body) as { error: string },
              statusCode: incoming.statusCode ?? 0,
            });
          } catch (error) {
            reject(error);
          }
        });
        incoming.on("error", reject);
      });
      oversizedRequest.on("error", reject);
    });

    oversizedRequest.write('{"manifest":{"files":["src/index.ts"]},"padding":"');
    oversizedRequest.write("x".repeat(1_100_000));

    await expect(oversizedResponse).resolves.toMatchObject({
      payload: {
        error: "Serve request body exceeds 1048576 bytes.",
      },
      statusCode: 413,
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("closes the connection for declared oversized serve request bodies", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-declared-oversized-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const oversizedRequest = httpRequest(`${listening.url}/run`, {
      headers: {
        "content-length": String(1_100_000),
        "content-type": "application/json",
      },
      method: "POST",
    });

    const oversizedResponse = new Promise<{
      headers: IncomingHttpHeaders;
      payload: { error: string };
      statusCode: number;
    }>((resolve, reject) => {
      oversizedRequest.on("response", (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({
              headers: incoming.headers,
              payload: JSON.parse(responseBody) as { error: string },
              statusCode: incoming.statusCode ?? 0,
            });
          } catch (error) {
            reject(error);
          }
        });
        incoming.on("error", reject);
      });
      oversizedRequest.on("error", reject);
    });

    oversizedRequest.end('{"manifest":{"files":["src/index.ts"]}}');

    await expect(oversizedResponse).resolves.toMatchObject({
      headers: {
        connection: "close",
      },
      payload: {
        error: "Serve request body exceeds 1048576 bytes.",
      },
      statusCode: 413,
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("releases the serve lock as soon as a streamed request exceeds the body limit", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-streaming-oversized-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const oversizedRequest = httpRequest(`${listening.url}/run`, {
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    const oversizedResponse = new Promise<
      { kind: "response"; payload: { error: string }; statusCode: number } | { kind: "early-close" }
    >((resolve, reject) => {
      oversizedRequest.on("response", (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({
              kind: "response",
              payload: JSON.parse(responseBody) as { error: string },
              statusCode: incoming.statusCode ?? 0,
            });
          } catch (error) {
            reject(error);
          }
        });
        incoming.on("error", reject);
      });
      oversizedRequest.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || error.code === "ECONNRESET") {
          resolve({ kind: "early-close" });
          return;
        }
        reject(error);
      });
    });

    oversizedRequest.write('{"manifest":{"files":["src/index.ts"]},"padding":"');
    oversizedRequest.write("x".repeat(1_100_000));

    const oversizedResult = await oversizedResponse;
    if (oversizedResult.kind === "response") {
      expect(oversizedResult).toEqual({
        kind: "response",
        payload: {
          error: "Serve request body exceeds 1048576 bytes.",
        },
        statusCode: 413,
      });
    }

    const recoveredResponse = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({
        manifest: {
          files: ["src/index.ts"],
        },
        stages: ["typecheck"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(recoveredResponse.status).toBe(200);
    await expect(recoveredResponse.json()).resolves.toMatchObject({
      context: "serve",
      request: {
        context: "serve",
      },
    });
    expect(stderr.value).toBe("");

    oversizedRequest.destroy();
    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});

describePackageSmoke("CLI package smoke", () => {
  it("runs built and packed package entrypoints without runtime resolution errors", async () => {
    await withExclusiveToolLock("cli-package-smoke", async () => {
      await ensurePackageSmokeBuild();

      const builtHelp = await runCommand(process.execPath, [builtCliPath, "--help"], {
        cwd: repoRoot,
      });
      expect(builtHelp.exitCode).toBe(0);
      expect(builtHelp.stderr).toBe("");
      expect(builtHelp.stdout).toContain("Usage:");

      const builtBench = await runCommand(
        process.execPath,
        [
          builtCliPath,
          "bench",
          "--scenario",
          "javascript-lint-single-file-cold",
          "--format",
          "json",
        ],
        { cwd: repoRoot },
      );
      expect(builtBench.exitCode).toBe(0);
      expect(builtBench.stderr).toBe("");
      expect(JSON.parse(builtBench.stdout)).toMatchObject({
        artifactType: "benchmark",
        summary: {
          scenarioCount: 1,
        },
      });

      const packedFixture = await createPackedPackageFixture();
      const cliPackage = packedFixture.packages.find((entry) => entry.workspace === "packages/cli");
      expect(cliPackage?.files.map((entry) => entry.path).sort()).toEqual(
        expect.arrayContaining([
          "README.md",
          "dist/api.js",
          "dist/benchmark/index.js",
          "dist/bin/aiq.js",
          "dist/config/index.js",
          "dist/engine/index.js",
          "dist/model/index.js",
          "dist/reporters/index.js",
        ]),
      );

      const installedPackageReadme = await readFile(
        path.join(packedFixture.root, "node_modules", "@tjalve", "aiq", "README.md"),
        "utf8",
      );
      expect(installedPackageReadme).toContain("# @tjalve/aiq");
      expect(installedPackageReadme).toContain("npx @tjalve/aiq");
      expect(installedPackageReadme).not.toContain("Repository Workflow");

      const packedHelp = await runNpmCommand(["exec", "--", "aiq", "--", "--help"], {
        cwd: packedFixture.root,
      });
      expect(packedHelp.exitCode).toBe(0);
      expect(packedHelp.stdout).toContain("Usage:");
      expect(packedHelp.stdout).toContain("aiq <files...>");
      expect(packedHelp.stdout).toContain("aiq run <files...>");
      expect(packedHelp.stdout).toContain("0=e2e 1=lint 2=format 3=typecheck");
      expect(packedHelp.stdout).toContain("--up-to <0-9>");
      expect(packedHelp.stdout).toContain("--only <0-9>");
      expect(packedHelp.stderr).not.toContain("ReferenceError");

      const packedSchema = await runNpmCommand(
        ["exec", "--", "aiq", "--", "schema", "--format", "json"],
        { cwd: packedFixture.root },
      );
      expect(packedSchema.exitCode).toBe(0);
      expect(packedSchema.stderr).not.toContain("ReferenceError");
      expect(JSON.parse(packedSchema.stdout)).toMatchObject({
        bin: "aiq",
        package: { name: "@tjalve/aiq" },
        schemaVersion: 1,
      });

      const packedFirstRun = await runNpmCommand(["exec", "--", "aiq"], {
        cwd: packedFixture.root,
      });
      expect(packedFirstRun.exitCode).toBe(0);
      expect(packedFirstRun.stderr).not.toContain("ReferenceError");
      expect(packedFirstRun.stdout).toContain("AIQ first run");
      expect(packedFirstRun.stdout).toContain("Detected project: JavaScript/Node (package.json)");
      expect(packedFirstRun.stdout).toContain("AIQ run");
      expect(packedFirstRun.stdout).toContain("- lint: passed");
      await access(path.join(packedFixture.root, ".aiq", "aiq.config.json"));
      await access(path.join(packedFixture.root, ".aiq", "progress.json"));

      const emptyDir = path.join(packedFixture.root, "empty");
      await mkdir(emptyDir);
      const packedEmptyFirstRun = await runNpmCommand(["exec", "--", "aiq"], {
        cwd: emptyDir,
      });
      expect(packedEmptyFirstRun.exitCode).toBe(2);
      expect(packedEmptyFirstRun.stderr).toBe("");
      expect(packedEmptyFirstRun.stdout).toContain("AIQ first run");
      expect(packedEmptyFirstRun.stdout).toContain("No supported project marker was found");
      expect(packedEmptyFirstRun.stdout).toContain("Examples:");

      const packedSetStage = await runNpmCommand(
        ["exec", "--", "aiq", "--", "config", "--set-stage", "3"],
        { cwd: packedFixture.root },
      );
      expect(packedSetStage.exitCode).toBe(0);
      expect(packedSetStage.stderr).not.toContain("ReferenceError");
      expect(packedSetStage.stdout).toContain("Set current_stage=3");

      const packedDefaultRunPlan = await runNpmCommand(
        ["exec", "--", "aiq", "--", "run", "src/index.ts", "--dry-run", "--format", "json"],
        { cwd: packedFixture.root },
      );
      expect(packedDefaultRunPlan.exitCode).toBe(0);
      expect(packedDefaultRunPlan.stderr).not.toContain("ReferenceError");
      const defaultRunPlan = JSON.parse(packedDefaultRunPlan.stdout) as {
        plan: { stages: string[] };
      };
      expect(defaultRunPlan.plan.stages).toEqual(["e2e", "lint", "format", "typecheck"]);

      const packedUpToRunPlan = await runNpmCommand(
        [
          "exec",
          "--",
          "aiq",
          "--",
          "run",
          "src/index.ts",
          "--up-to",
          "3",
          "--dry-run",
          "--format",
          "json",
        ],
        { cwd: packedFixture.root },
      );
      expect(packedUpToRunPlan.exitCode).toBe(0);
      expect(packedUpToRunPlan.stderr).not.toContain("ReferenceError");
      const upToRunPlan = JSON.parse(packedUpToRunPlan.stdout) as {
        plan: { stages: string[] };
      };
      expect(upToRunPlan.plan.stages).toEqual(["e2e", "lint", "format", "typecheck"]);

      const packedOnlyRun = await runNpmCommand(
        ["exec", "--", "aiq", "--", "run", "src/index.ts", "--only", "1"],
        { cwd: packedFixture.root },
      );
      expect(packedOnlyRun.exitCode).toBe(0);
      expect(packedOnlyRun.stderr).not.toContain("ReferenceError");
      expect(packedOnlyRun.stdout).toContain("AIQ run");
      expect(packedOnlyRun.stdout).toContain("- lint: passed");
      expect(packedOnlyRun.stdout).not.toContain("AIQ check");

      const packedImplicitRun = await runNpmCommand(
        ["exec", "--", "aiq", "--", "src/index.ts", "--only", "1"],
        { cwd: packedFixture.root },
      );
      expect(packedImplicitRun.exitCode).toBe(0);
      expect(packedImplicitRun.stderr).not.toContain("ReferenceError");
      expect(packedImplicitRun.stdout).toContain("AIQ run");
      expect(packedImplicitRun.stdout).toContain("- lint: passed");
      expect(packedImplicitRun.stdout).not.toContain("AIQ check");

      const packedRunJson = await runNpmCommand(
        ["exec", "--", "aiq", "--", "run", "src/index.ts", "--only", "1", "--format", "json"],
        { cwd: packedFixture.root },
      );
      expect(packedRunJson.exitCode).toBe(0);
      expect(packedRunJson.stderr).not.toContain("ReferenceError");

      const packedReport = JSON.parse(packedRunJson.stdout) as {
        context: string;
        request: { context: string; selection: { stages: string[] } };
        summary: { fileCount: number; status: string };
      };
      expect(packedReport.context).toBe("cli");
      expect(packedReport.request.context).toBe("cli");
      expect(packedReport.request.selection.stages).toEqual(["lint"]);
      expect(packedReport.summary.fileCount).toBe(1);
      expect(packedReport.summary.status).toBe("passed");

      const packedDoctor = await runNpmCommand(
        ["exec", "--", "aiq", "--", "doctor", "--only", "1"],
        {
          cwd: packedFixture.root,
        },
      );
      expect(packedDoctor.exitCode).toBe(0);
      expect(packedDoctor.stderr).not.toContain("ReferenceError");
      expect(packedDoctor.stdout).toContain("AIQ doctor");
      expect(packedDoctor.stdout).toContain("Stages: lint");

      const packedRemovedCommand = await runNpmCommand(["exec", "--", "aiq", "--", "ci", "setup"], {
        cwd: packedFixture.root,
      });
      expect(packedRemovedCommand.exitCode).toBe(0);
      expect(packedRemovedCommand.stderr).not.toContain("ReferenceError");
      expect(packedRemovedCommand.stdout).toContain(
        "CI setup uses explicit workflow configuration",
      );

      const packedBench = await runNpmCommand(
        [
          "exec",
          "--",
          "aiq",
          "--",
          "bench",
          "--corpus-root",
          repoRoot,
          "--scenario",
          "javascript-lint-single-file-cold",
          "--format",
          "json",
        ],
        { cwd: packedFixture.root },
      );
      expect(packedBench.exitCode).toBe(0);
      expect(packedBench.stderr).not.toContain("ReferenceError");
      expect(JSON.parse(packedBench.stdout)).toMatchObject({
        artifactType: "benchmark",
        selection: {
          scenarioIds: ["javascript-lint-single-file-cold"],
        },
        summary: {
          scenarioCount: 1,
        },
      });

      const packedTopLevelImport = await runCommand(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const pkg = await import('@tjalve/aiq'); console.log(typeof pkg.runCli);",
        ],
        { cwd: packedFixture.root },
      );
      expect(packedTopLevelImport.exitCode).toBe(0);
      expect(packedTopLevelImport.stderr).toBe("");
      expect(packedTopLevelImport.stdout.trim()).toBe("function");

      const packedApiImport = await runCommand(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            "const api = await import('@tjalve/aiq/api');",
            "console.log(JSON.stringify({",
            "runEngine: typeof api.runEngine,",
            "createRunPlan: typeof api.createRunPlan,",
            "resolveAiqConfig: typeof api.resolveAiqConfig,",
            "stageIds: Array.isArray(api.stageIds),",
            "formatRunResultAsText: typeof api.formatRunResultAsText,",
            "runBenchmarkSuite: typeof api.runBenchmarkSuite",
            "}));",
          ].join(" "),
        ],
        { cwd: packedFixture.root },
      );
      expect(packedApiImport.exitCode).toBe(0);
      expect(packedApiImport.stderr).toBe("");
      expect(JSON.parse(packedApiImport.stdout) as Record<string, unknown>).toEqual({
        createRunPlan: "function",
        formatRunResultAsText: "function",
        resolveAiqConfig: "function",
        runBenchmarkSuite: "function",
        runEngine: "function",
        stageIds: true,
      });

      const packedSchemaImport = await runCommand(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            "const schema = await import('@tjalve/aiq/schema');",
            "const rendered = schema.renderAiqCommandSchema();",
            "console.log(JSON.stringify({",
            "render: typeof schema.renderAiqCommandSchema,",
            "json: typeof schema.renderAiqCommandSchemaJson,",
            "commands: rendered.commands.length",
            "}));",
          ].join(" "),
        ],
        { cwd: packedFixture.root },
      );
      expect(packedSchemaImport.exitCode).toBe(0);
      expect(packedSchemaImport.stderr).toBe("");
      expect(JSON.parse(packedSchemaImport.stdout) as Record<string, unknown>).toEqual({
        commands: 8,
        json: "function",
        render: "function",
      });

      const packedSubpathImport = await runCommand(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            "const benchmark = await import('@tjalve/aiq/benchmark');",
            "const config = await import('@tjalve/aiq/config');",
            "const engine = await import('@tjalve/aiq/engine');",
            "const model = await import('@tjalve/aiq/model');",
            "const reporters = await import('@tjalve/aiq/reporters');",
            "console.log(JSON.stringify({",
            "runBenchmarkSuite: typeof benchmark.runBenchmarkSuite,",
            "resolveAiqConfig: typeof config.resolveAiqConfig,",
            "runEngine: typeof engine.runEngine,",
            "stageIds: Array.isArray(model.stageIds),",
            "formatRunResultAsText: typeof reporters.formatRunResultAsText",
            "}));",
          ].join(" "),
        ],
        { cwd: packedFixture.root },
      );
      expect(packedSubpathImport.exitCode).toBe(0);
      expect(packedSubpathImport.stderr).toBe("");
      expect(JSON.parse(packedSubpathImport.stdout) as Record<string, unknown>).toEqual({
        formatRunResultAsText: "function",
        resolveAiqConfig: "function",
        runBenchmarkSuite: "function",
        runEngine: "function",
        stageIds: true,
      });
    });
  }, 120_000);
});
