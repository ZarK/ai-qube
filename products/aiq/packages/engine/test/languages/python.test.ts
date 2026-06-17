import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildProjectGraph } from "../../src/graph.js";
import { normalizeFileManifest } from "../../src/index.js";
import { discoverPythonProjects, selectPythonProjects } from "../../src/languages/python.js";

const fixturePythonRoot = path.resolve("test-projects/python");
const fixturePythonConfigFile = path.join(fixturePythonRoot, "pyproject.toml");
const fixturePythonFile = path.join(fixturePythonRoot, "main.py");
const fixturePythonTestFile = path.join(fixturePythonRoot, "tests", "test_main.py");

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
});
