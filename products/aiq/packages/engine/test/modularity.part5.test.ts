import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlannedTask, ProjectDescriptor } from "../src/contracts.js";
import {
  buildProjectGraph,
  buildProjectGraphWithModules,
  createGraphLanguageModuleRegistry,
  defaultGraphLanguageModules,
} from "../src/graph.js";
import { buildEngineContext, normalizeFileManifest } from "../src/index.js";
import {
  combineStageResults,
  createCombinedStageDefinition,
  createNoopStageResult,
  createNotImplementedStageResult,
  createRunnerExecutionContext,
  createRunnerLanguageModuleRegistry,
  defaultRunnerLanguageModules,
  defaultStageDefinitions,
  resolveStageHandlersFromModules,
  runnerExecutionContextStorage,
} from "../src/runners.js";
import {
  commandAvailable,
  hasDotNet10Toolchain,
  hasGoToolchain,
  hasMavenToolchain,
  hasPowerShellPesterToolchain,
  hasPythonQualityToolchain,
  hasRustToolchain,
} from "./toolchain-capabilities.js";

const tempDirs: string[] = [];
const fixtureBashFile = path.resolve("test-projects/bash/example.sh");
const fixtureDotNetFile = path.resolve("test-projects/dotnet/src/DotNetFixture/Greeter.cs");
const fixtureGoFile = path.resolve("test-projects/go/greeter.go");
const fixtureJavaMavenFile = path.resolve(
  "test-projects/java-maven/src/main/java/dev/aiq/fixture/Greeting.java",
);
const fixturePowerShellFile = path.resolve("test-projects/powershell/example.ps1");
const fixturePythonConfigFile = path.resolve("test-projects/python/pyproject.toml");
const fixtureRustFile = path.resolve("test-projects/rust/src/lib.rs");
const fixtureTerraformFile = path.resolve("test-projects/terraform/main.tf");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempFile(
  fileName: string,
  contents: string,
): Promise<{ file: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-modularity-"));
  tempDirs.push(root);

  const file = path.join(root, fileName);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");

  return { file, root };
}

function createStageResult(
  stageId: PlannedTask["stageId"],
  status: "failed" | "passed" | "not_implemented",
) {
  return {
    diagnostics: [],
    durationMs: status === "passed" ? 5 : 1,
    notes: [status],
    stageId,
    status,
    toolRuns: [],
  };
}

describe("engine modular authoring path", () => {
  it("runs a real Bash fixture through an injected runner registry path", async () => {
    const hasBats = commandAvailable("bats");
    const context = await buildEngineContext({
      context: "cli",
      manifest: {
        files: [fixtureBashFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(process.cwd(), ".aiq", "out"),
      stages: ["unit"],
      writeArtifacts: false,
    });
    const stageDefinition = createCombinedStageDefinition("unit", ["bash"]);
    const bashModule = defaultRunnerLanguageModules.byId.get("bash");
    if (bashModule === undefined) {
      throw new Error("Expected the default Bash runner module to exist.");
    }

    const modules = createRunnerLanguageModuleRegistry([bashModule]);
    const task: PlannedTask = {
      fileCount: 1,
      files: [fixtureBashFile],
      id: "run-1:1:bash-unit",
      stageId: "unit",
    };
    const runnerContext = createRunnerExecutionContext(context);

    const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
      const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
      expect(handlers).toHaveLength(1);

      const [handler] = handlers;
      if (handler === undefined) {
        throw new Error("Expected a Bash unit handler.");
      }

      return handler.handler(
        { ...task, files: handler.files },
        { cwd: runnerContext.cwd, signal: runnerContext.signal },
      );
    });

    if (!hasBats) {
      expect(JSON.stringify(result)).not.toContain("not_implemented");
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: fixtureBashFile,
        severity: "error",
        source: "bats",
      });
      expect(result.toolRuns[0]).toMatchObject({ status: "failed", tool: "bats" });
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "bats" });
  }, 30_000);

  it.skipIf(!hasPowerShellPesterToolchain)(
    "runs a real PowerShell fixture through an injected runner registry path",
    async () => {
      const context = await buildEngineContext({
        context: "cli",
        manifest: {
          files: [fixturePowerShellFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(process.cwd(), ".aiq", "out"),
        stages: ["unit"],
        writeArtifacts: false,
      });
      const stageDefinition = createCombinedStageDefinition("unit", ["powershell"]);
      const powerShellModule = defaultRunnerLanguageModules.byId.get("powershell");
      if (powerShellModule === undefined) {
        throw new Error("Expected the default PowerShell runner module to exist.");
      }

      const modules = createRunnerLanguageModuleRegistry([powerShellModule]);
      const task: PlannedTask = {
        fileCount: 1,
        files: [fixturePowerShellFile],
        id: "run-1:1:powershell-unit",
        stageId: "unit",
      };
      const runnerContext = createRunnerExecutionContext(context);

      const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
        const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
        expect(handlers).toHaveLength(1);

        const [handler] = handlers;
        if (handler === undefined) {
          throw new Error("Expected a PowerShell unit handler.");
        }

        return handler.handler(
          { ...task, files: handler.files },
          { cwd: runnerContext.cwd, signal: runnerContext.signal },
        );
      });

      expect(result.status).toBe("passed");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "pester" });
    },
    60_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs a real JVM fixture through an injected runner registry path",
    async () => {
      const context = await buildEngineContext({
        context: "cli",
        manifest: {
          files: [fixtureJavaMavenFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(process.cwd(), ".aiq", "out"),
        stages: ["unit"],
        writeArtifacts: false,
      });
      const stageDefinition = createCombinedStageDefinition("unit", ["jvm"]);
      const jvmModule = defaultRunnerLanguageModules.byId.get("jvm");
      if (jvmModule === undefined) {
        throw new Error("Expected the default JVM runner module to exist.");
      }

      const modules = createRunnerLanguageModuleRegistry([jvmModule]);
      const task: PlannedTask = {
        fileCount: 1,
        files: [fixtureJavaMavenFile],
        id: "run-1:1:jvm-unit",
        stageId: "unit",
      };
      const runnerContext = createRunnerExecutionContext(context);

      const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
        const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
        expect(handlers).toHaveLength(1);

        const [handler] = handlers;
        if (handler === undefined) {
          throw new Error("Expected a JVM unit handler.");
        }

        return handler.handler(
          { ...task, files: handler.files },
          { cwd: runnerContext.cwd, signal: runnerContext.signal },
        );
      });

      expect(result.status).toBe("passed");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "maven-test" });
    },
    120_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs a real dotnet fixture through an injected runner registry path",
    async () => {
      const context = await buildEngineContext({
        context: "cli",
        manifest: {
          files: [fixtureDotNetFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(process.cwd(), ".aiq", "out"),
        stages: ["unit"],
        writeArtifacts: false,
      });
      const stageDefinition = createCombinedStageDefinition("unit", ["dotnet"]);
      const dotNetModule = defaultRunnerLanguageModules.byId.get("dotnet");
      if (dotNetModule === undefined) {
        throw new Error("Expected the default dotnet runner module to exist.");
      }

      const modules = createRunnerLanguageModuleRegistry([dotNetModule]);
      const task: PlannedTask = {
        fileCount: 1,
        files: [fixtureDotNetFile],
        id: "run-1:1:dotnet-unit",
        stageId: "unit",
      };
      const runnerContext = createRunnerExecutionContext(context);

      const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
        const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
        expect(handlers).toHaveLength(1);

        const [handler] = handlers;
        if (handler === undefined) {
          throw new Error("Expected a dotnet unit handler.");
        }

        return handler.handler(
          { ...task, files: handler.files },
          { cwd: runnerContext.cwd, signal: runnerContext.signal },
        );
      });

      expect(result.status).toBe("passed");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "dotnet-test" });
    },
    120_000,
  );
});
