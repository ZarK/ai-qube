import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProjectGraph } from "../../src/graph.js";
import { normalizeFileManifest } from "../../src/index.js";
import { discoverPythonProjects, selectPythonProjects } from "../../src/languages/python.js";
import {
  runPythonFormatTask,
  runPythonLintTask,
  runPythonTypecheckTask,
} from "../../src/languages/python-quality.js";
import { buildEngineContext } from "../../src/request.js";
import { createPythonRunnerRuntime } from "../../src/runner-runtimes.js";
import { runPlannedTask } from "../../src/runners.js";
import { ToolRunner } from "../../src/tool-runner.js";
import * as hostTools from "../../src/tools/host-tools.js";

const fixturePythonRoot = path.resolve("test-projects/python");
const fixturePythonConfigFile = path.join(fixturePythonRoot, "pyproject.toml");
const fixturePythonFile = path.join(fixturePythonRoot, "main.py");
const fixturePythonTestFile = path.join(fixturePythonRoot, "tests", "test_main.py");
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("python language module", () => {
  it("discovers the fixture project from a Python source file", async () => {
    await expect(discoverPythonProjects(fixturePythonFile)).resolves.toEqual([
      {
        ecosystem: "python",
        id: `python:${fixturePythonRoot}`,
        language: "python",
        manifestFiles: [fixturePythonConfigFile],
        metadata: {
          kind: "python",
        },
        name: "python",
        root: fixturePythonRoot,
        sourceFiles: [fixturePythonFile],
      },
    ]);
  });

  it("discovers the fixture project from a Python config file", async () => {
    await expect(discoverPythonProjects(fixturePythonConfigFile)).resolves.toEqual([
      {
        ecosystem: "python",
        id: `python:${fixturePythonRoot}`,
        language: "python",
        manifestFiles: [fixturePythonConfigFile],
        metadata: {
          kind: "python",
        },
        name: "python",
        root: fixturePythonRoot,
        sourceFiles: [],
      },
    ]);
  });

  it("selects one Python project from a graph-backed mixed source and config selection", async () => {
    const manifest = await normalizeFileManifest(
      {
        files: [fixturePythonConfigFile, fixturePythonFile, fixturePythonTestFile],
        source: "direct",
      },
      fixturePythonRoot,
    );
    const graph = await buildProjectGraph(manifest);

    expect(
      selectPythonProjects(graph, [
        fixturePythonConfigFile,
        fixturePythonFile,
        fixturePythonTestFile,
      ]),
    ).toEqual([
      {
        files: [fixturePythonFile, fixturePythonConfigFile, fixturePythonTestFile],
        projectRoot: fixturePythonRoot,
      },
    ]);
  });

  it.each(["lint", "format", "typecheck"] as const)(
    "warns when a configuration-only directory has no source for %s",
    async (stageId) => {
      const root = await createPythonConfigProject();
      const runSpy = vi.spyOn(ToolRunner.prototype, "run");
      const context = await buildEngineContext({
        cwd: root,
        manifest: { files: [root], source: "direct" },
        mode: "check",
        stages: [stageId],
        writeArtifacts: false,
      });
      const result = await runPlannedTask(
        {
          fileCount: context.manifest.files.length,
          files: context.manifest.files,
          id: stageId,
          stageId,
        },
        context,
      );

      expect(result.status).toBe("warning");
      expect(result.toolRuns).toEqual([]);
      const handlers = {
        lint: runPythonLintTask,
        format: runPythonFormatTask,
        typecheck: runPythonTypecheckTask,
      };
      const sourceResult = await handlers[stageId](
        {
          fileCount: context.manifest.files.length,
          files: context.manifest.files,
          id: stageId,
          stageId,
        },
        createPythonRunnerRuntime(root, undefined),
      );
      expect(sourceResult.status).toBe("warning");
      expect(sourceResult.notes).toContain(`No Python source files were found for ${stageId}.`);
      expect(runSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["lint", "format", "typecheck"] as const)(
    "keeps ignored sources excluded from a configuration-only directory during %s",
    async (stageId) => {
      const root = await createPythonConfigProject();
      await writeFile(path.join(root, "ignored.py"), "invalid Python\n");
      const runSpy = vi.spyOn(ToolRunner.prototype, "run");
      const context = await buildEngineContext({
        cwd: root,
        manifest: {
          files: [root],
          ignore: ["**/ignored.py"],
          source: "direct",
        },
        mode: "check",
        stages: [stageId],
        writeArtifacts: false,
      });
      expect(context.manifest.files).toEqual([path.join(root, "pyproject.toml")]);
      const result = await runPlannedTask(
        {
          fileCount: context.manifest.files.length,
          files: context.manifest.files,
          id: stageId,
          stageId,
        },
        context,
      );

      expect(result.status).toBe("warning");
      expect(result.toolRuns).toEqual([]);
      expect(runSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["lint", "format", "typecheck"] as const)(
    "passes only unignored discovered Python files to %s",
    async (stageId) => {
      const root = await createPythonConfigProject();
      const sourceFile = path.join(root, "main.py");
      await writeFile(sourceFile, "value = 1\n");
      await writeFile(path.join(root, "ignored.py"), "invalid Python\n");
      await mkdir(path.join(root, "excluded"));
      await writeFile(path.join(root, "excluded", "nested.py"), "invalid Python\n");
      vi.spyOn(hostTools, "requirePathCommand").mockImplementation(async (command) => command);
      vi.spyOn(hostTools, "resolvePythonInterpreter").mockResolvedValue("python");
      const runSpy = vi.spyOn(ToolRunner.prototype, "run").mockResolvedValue({
        durationMs: 1,
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stderr: "",
        stdout: stageId === "format" ? "" : "[]",
      });
      const context = await buildEngineContext({
        cwd: root,
        manifest: {
          files: [path.join(root, "pyproject.toml")],
          ignore: ["**/ignored.py", "excluded/"],
          source: "direct",
        },
        mode: "check",
        stages: [stageId],
        writeArtifacts: false,
      });
      const result = await runPlannedTask(
        {
          fileCount: context.manifest.files.length,
          files: context.manifest.files,
          id: stageId,
          stageId,
        },
        context,
      );

      expect(result.status).toBe("passed");
      expect(runSpy).toHaveBeenCalledOnce();
      expect(runSpy.mock.calls[0]?.[1].filter((argument) => argument.endsWith(".py"))).toEqual([
        sourceFile,
      ]);
    },
  );
});

async function createPythonConfigProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-python-selection-"));
  tempDirs.push(root);
  await writeFile(
    path.join(root, "pyproject.toml"),
    '[project]\nname = "selection"\nversion = "0.1.0"\n',
  );
  return root;
}
