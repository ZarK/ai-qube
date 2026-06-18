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
  it("runs a real Go fixture through an injected runner registry path", async () => {
    const hasGo = commandAvailable("go");
    const context = await buildEngineContext({
      context: "cli",
      manifest: {
        files: [fixtureGoFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(process.cwd(), ".aiq", "out"),
      stages: ["unit"],
      writeArtifacts: false,
    });
    const stageDefinition = createCombinedStageDefinition("unit", ["go"]);
    const goModule = defaultRunnerLanguageModules.byId.get("go");
    if (goModule === undefined) {
      throw new Error("Expected the default Go runner module to exist.");
    }

    const modules = createRunnerLanguageModuleRegistry([goModule]);
    const task: PlannedTask = {
      fileCount: 1,
      files: [fixtureGoFile],
      id: "run-1:1:go-unit",
      stageId: "unit",
    };
    const runnerContext = createRunnerExecutionContext(context);

    const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
      const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
      expect(handlers).toHaveLength(1);

      const [handler] = handlers;
      if (handler === undefined) {
        throw new Error("Expected a Go unit handler.");
      }

      return handler.handler(
        { ...task, files: handler.files },
        { cwd: runnerContext.cwd, signal: runnerContext.signal },
      );
    });

    if (!hasGo) {
      expect(result.status).toBe("failed");
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "go-test" });
  }, 30_000);

  it.skipIf(!hasRustToolchain)(
    "runs a real Rust fixture through an injected runner registry path",
    async () => {
      const context = await buildEngineContext({
        context: "cli",
        manifest: {
          files: [fixtureRustFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(process.cwd(), ".aiq", "out"),
        stages: ["unit"],
        writeArtifacts: false,
      });
      const stageDefinition = createCombinedStageDefinition("unit", ["rust"]);
      const rustModule = defaultRunnerLanguageModules.byId.get("rust");
      if (rustModule === undefined) {
        throw new Error("Expected the default Rust runner module to exist.");
      }

      const modules = createRunnerLanguageModuleRegistry([rustModule]);
      const task: PlannedTask = {
        fileCount: 1,
        files: [fixtureRustFile],
        id: "run-1:1:rust-unit",
        stageId: "unit",
      };
      const runnerContext = createRunnerExecutionContext(context);

      const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
        const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
        expect(handlers).toHaveLength(1);

        const [handler] = handlers;
        if (handler === undefined) {
          throw new Error("Expected a Rust unit handler.");
        }

        return handler.handler(
          { ...task, files: handler.files },
          { cwd: runnerContext.cwd, signal: runnerContext.signal },
        );
      });

      expect(result.status).toBe("passed");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "cargo-test" });
    },
    60_000,
  );
});
