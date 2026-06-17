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
  it("builds graphs from injected language modules without touching the default registry", async () => {
    const project = await createTempFile("src/example.synthetic", "value\n");
    const manifest = await normalizeFileManifest(
      { files: [project.file], source: "direct" },
      project.root,
    );

    const modules = createGraphLanguageModuleRegistry([
      {
        id: "synthetic",
        async discoverProjects(file): Promise<ProjectDescriptor[]> {
          const resolvedFile = path.resolve(file);
          if (!resolvedFile.endsWith(".synthetic")) {
            return [];
          }

          return [
            {
              ecosystem: "unknown",
              id: `synthetic:${resolvedFile}`,
              language: "synthetic",
              manifestFiles: [],
              metadata: { kind: "synthetic" },
              name: "synthetic project",
              root: path.dirname(resolvedFile),
              sourceFiles: [resolvedFile],
            },
          ];
        },
      },
    ]);

    const graph = await buildProjectGraphWithModules(manifest, modules);

    expect(graph.projects).toEqual([
      {
        ecosystem: "unknown",
        id: `synthetic:${project.file}`,
        language: "synthetic",
        manifestFiles: [],
        metadata: { kind: "synthetic" },
        name: "synthetic project",
        root: path.dirname(project.file),
        sourceFiles: [project.file],
      },
    ]);
    expect(graph.fileToProjectIds[project.file]).toEqual([`synthetic:${project.file}`]);
  });

  it("keeps the injectable graph registry path aligned with the default fixture-backed path", async () => {
    const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
    const manifest = await normalizeFileManifest(
      { files: [fixtureFile], source: "direct" },
      process.cwd(),
    );

    const defaultGraph = await buildProjectGraph(manifest);
    const modularGraph = await buildProjectGraphWithModules(manifest, defaultGraphLanguageModules);

    expect(modularGraph).toEqual(defaultGraph);
  });

  it("resolves injected runner language modules from a bounded stage definition", () => {
    const stageDefinition = createCombinedStageDefinition("lint", ["synthetic"]);
    const task: PlannedTask = {
      fileCount: 1,
      files: ["src/example.synthetic"],
      id: "run-1:1:lint",
      stageId: "lint",
    };
    const modules = createRunnerLanguageModuleRegistry([
      {
        id: "synthetic",
        stageHandlers: {
          lint: async (_task) => createStageResult(_task.stageId, "passed"),
        },
      },
    ]);

    runnerExecutionContextStorage.run(createRunnerExecutionContext(process.cwd()), () => {
      const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);

      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.files).toEqual(["src/example.synthetic"]);
    });
  });

  it("runs a real fixture through an injected runner registry path", async () => {
    const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
    const context = await buildEngineContext({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(process.cwd(), ".aiq", "out"),
      stages: ["unit"],
      writeArtifacts: false,
    });
    const stageDefinition = createCombinedStageDefinition("unit", ["javascript"]);
    const javascriptModule = defaultRunnerLanguageModules.byId.get("javascript");
    if (javascriptModule === undefined) {
      throw new Error("Expected the default JavaScript runner module to exist.");
    }

    const modules = createRunnerLanguageModuleRegistry([javascriptModule]);
    const task: PlannedTask = {
      fileCount: 1,
      files: [fixtureFile],
      id: "run-1:1:unit",
      stageId: "unit",
    };
    const runnerContext = createRunnerExecutionContext(context);

    const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
      const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
      expect(handlers).toHaveLength(1);

      const [handler] = handlers;
      if (handler === undefined) {
        throw new Error("Expected a JavaScript unit handler.");
      }

      return handler.handler(
        { ...task, files: handler.files },
        { cwd: runnerContext.cwd, signal: runnerContext.signal },
      );
    });

    expect(result.status).toBe("passed");
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "vitest" });
  }, 20_000);

  it.skipIf(!hasPythonQualityToolchain)(
    "runs a real Python fixture through an injected runner registry path",
    async () => {
      const context = await buildEngineContext({
        context: "cli",
        manifest: {
          files: [fixturePythonConfigFile],
          source: "direct",
        },
        mode: "check",
        outDir: path.join(process.cwd(), ".aiq", "out"),
        stages: ["lint"],
        writeArtifacts: false,
      });
      const stageDefinition = createCombinedStageDefinition("lint", ["python"]);
      const pythonModule = defaultRunnerLanguageModules.byId.get("python");
      if (pythonModule === undefined) {
        throw new Error("Expected the default Python runner module to exist.");
      }

      const modules = createRunnerLanguageModuleRegistry([pythonModule]);
      const task: PlannedTask = {
        fileCount: 1,
        files: [fixturePythonConfigFile],
        id: "run-1:1:lint",
        stageId: "lint",
      };
      const runnerContext = createRunnerExecutionContext(context);

      const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
        const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
        expect(handlers).toHaveLength(1);

        const [handler] = handlers;
        if (handler === undefined) {
          throw new Error("Expected a Python lint handler.");
        }

        return handler.handler(
          { ...task, files: handler.files },
          { cwd: runnerContext.cwd, signal: runnerContext.signal },
        );
      });

      expect(result.status).toBe("passed");
      expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "ruff" });
    },
    20_000,
  );

  it("runs a real Terraform fixture through an injected runner registry path", async () => {
    const hasTerraform = commandAvailable("terraform");
    const context = await buildEngineContext({
      context: "cli",
      manifest: {
        files: [fixtureTerraformFile],
        source: "direct",
      },
      mode: "check",
      outDir: path.join(process.cwd(), ".aiq", "out"),
      stages: ["lint"],
      writeArtifacts: false,
    });
    const stageDefinition = createCombinedStageDefinition("lint", ["terraform"]);
    const terraformModule = defaultRunnerLanguageModules.byId.get("terraform");
    if (terraformModule === undefined) {
      throw new Error("Expected the default Terraform runner module to exist.");
    }

    const modules = createRunnerLanguageModuleRegistry([terraformModule]);
    const task: PlannedTask = {
      fileCount: 1,
      files: [fixtureTerraformFile],
      id: "run-1:1:terraform-lint",
      stageId: "lint",
    };
    const runnerContext = createRunnerExecutionContext(context);

    const result = await runnerExecutionContextStorage.run(runnerContext, async () => {
      const handlers = resolveStageHandlersFromModules(stageDefinition, task, modules);
      expect(handlers).toHaveLength(1);

      const [handler] = handlers;
      if (handler === undefined) {
        throw new Error("Expected a Terraform lint handler.");
      }

      return handler.handler(
        { ...task, files: handler.files },
        { cwd: runnerContext.cwd, signal: runnerContext.signal },
      );
    });

    if (!hasTerraform) {
      expect(JSON.stringify(result)).not.toContain("not_implemented");
      expect(result.status).toBe("failed");
      expect(result.notes[0]).toContain("requires the 'terraform' binary");
      expect(result.notes[0]).toContain("aiq doctor");
      expect(result.diagnostics[0]).toMatchObject({
        file: fixtureTerraformFile,
        severity: "error",
        source: "terraform",
      });
      expect(result.toolRuns).toEqual([
        expect.objectContaining({ status: "failed", tool: "terraform" }),
      ]);
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", tool: "terraform-init" }),
        expect.objectContaining({ status: "passed", tool: "terraform-validate" }),
      ]),
    );
  }, 20_000);

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
      expect(result.status).toBe("not_implemented");
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

  it("keeps default stage definitions aligned with the registered runner modules", () => {
    expect(defaultStageDefinitions.entries).not.toHaveLength(0);

    for (const stageDefinition of defaultStageDefinitions.entries) {
      for (const moduleId of stageDefinition.moduleIds) {
        expect(defaultRunnerLanguageModules.byId.has(moduleId)).toBe(true);
      }
    }
  });

  it("combines stage results with canonical precedence and noop collapse", () => {
    expect(combineStageResults("lint", [createNoopStageResult("lint", "skip")])).toEqual(
      createNoopStageResult("lint", "No supported files were selected for lint."),
    );

    expect(
      combineStageResults("lint", [
        createStageResult("lint", "not_implemented"),
        createStageResult("lint", "passed"),
      ]).status,
    ).toBe("not_implemented");

    expect(
      combineStageResults("lint", [
        createNotImplementedStageResult("lint"),
        createStageResult("lint", "failed"),
      ]).status,
    ).toBe("failed");
  });
});
