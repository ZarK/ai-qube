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
});
