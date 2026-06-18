import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileMetricDiagnostics,
  createLizardMetricsDiagnostics,
  createPythonMetricsDiagnostics,
  metricsDiagnosticCodes,
  readMetricsThresholds,
} from "../src/metrics-thresholds.js";
import { parseDotNetTrxReport } from "../src/parsers/dotnet.js";
import { parseGoVetDiagnostics } from "../src/parsers/go.js";
import { parseLizardMetrics } from "../src/parsers/lizard.js";
import { parsePytestReport, parseTyGitlabDiagnostics } from "../src/parsers/python.js";
import { capitalize, resolveDiagnosticFile } from "../src/parsers/utils.js";
import { parseXmlAttributes } from "../src/parsers/xml.js";
import { createRegistry } from "../src/registries.js";
import {
  createBiomeLintArgs,
  createDirectJavaScriptTestArgs,
  createJavaScriptTestArgs,
  createPlaywrightTestArgs,
  createPythonTestArgs,
  createTerraformInitArgs,
  createTyCheckArgs,
} from "../src/tools/command-builders.js";
import { createJavaScriptTestCommand } from "../src/tools/node.js";
import { resolveJavaScriptTestExecutionMode } from "../src/utils/node-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTempSourceFile(contents: string): Promise<{ file: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-extracted-helpers-"));
  tempDirs.push(root);

  const file = path.join(root, "fixture.ts");
  await writeFile(file, contents, "utf8");

  return { file, root };
}

async function createTempPackageProject(
  testScript: string,
): Promise<{ packageJsonPath: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-js-runner-helper-"));
  tempDirs.push(root);

  const packageJsonPath = path.join(root, "package.json");
  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ name: "fixture", private: true, scripts: { test: testScript } }, null, 2)}\n`,
    "utf8",
  );

  return { packageJsonPath, root };
}

describe("extracted helper regressions", () => {
  it("uses direct JavaScript test execution only for exact plain runner scripts", async () => {
    const directVitestProject = await createTempPackageProject("  vitest  ");
    const wrappedVitestProject = await createTempPackageProject("vitest --run");
    const customScriptProject = await createTempPackageProject("node runner.cjs");

    await expect(
      resolveJavaScriptTestExecutionMode(directVitestProject.root, "vitest"),
    ).resolves.toBe("direct");
    await expect(
      resolveJavaScriptTestExecutionMode(wrappedVitestProject.root, "vitest"),
    ).resolves.toBe("npm");
    await expect(
      resolveJavaScriptTestExecutionMode(customScriptProject.root, "jest"),
    ).resolves.toBe("npm");
  });

  it("builds direct JavaScript test commands only when the execution mode opts in", () => {
    const directVitest = createJavaScriptTestCommand({
      coverageDirectory: "/tmp/coverage",
      executionMode: "direct",
      mode: "unit",
      reportPath: "/tmp/report.json",
      runner: "vitest",
    });
    const npmJest = createJavaScriptTestCommand({
      coverageDirectory: "/tmp/coverage",
      executionMode: "npm",
      mode: "unit",
      reportPath: "/tmp/report.json",
      runner: "jest",
    });

    expect(directVitest.command).toBe(process.execPath);
    expect(directVitest.args).toEqual([
      expect.stringContaining(`${path.sep}node_modules${path.sep}vitest${path.sep}vitest.mjs`),
      "--passWithNoTests",
      "--reporter=json",
      "--outputFile=/tmp/report.json",
      "--run",
      "--pool=threads",
      "--poolOptions.threads.maxThreads=1",
      "--poolOptions.threads.minThreads=1",
      "--no-file-parallelism",
    ]);
    expect(npmJest).toEqual({
      args: [
        "test",
        "--",
        "--passWithNoTests",
        "--runInBand",
        "--json",
        "--outputFile=/tmp/report.json",
      ],
      command: process.platform === "win32" ? "npm.cmd" : "npm",
    });
  });

  it("indexes registry entries by id while preserving declaration order", () => {
    const registry = createRegistry([
      { id: "lint", label: "Lint" },
      { id: "format", label: "Format" },
    ]);

    expect(registry.entries.map((entry) => entry.id)).toEqual(["lint", "format"]);
    expect(registry.byId.get("format")).toEqual({ id: "format", label: "Format" });
  });

  it("snapshots registry entries so caller mutations do not affect the registry", () => {
    const entries = [{ id: "lint", label: "Lint" }];
    const registry = createRegistry(entries);

    entries.push({ id: "format", label: "Format" });

    expect(registry.entries).toEqual([{ id: "lint", label: "Lint" }]);
    expect(registry.byId.has("format")).toBe(false);
  });

  it("clones registry entries so entry object mutations do not affect the registry", () => {
    const entries = [{ id: "lint", label: "Lint" }];
    const registry = createRegistry(entries);
    const [lintEntry] = entries;

    if (lintEntry === undefined) {
      throw new Error("Expected a registry entry to mutate.");
    }

    lintEntry.label = "Changed";

    expect(registry.entries).toEqual([{ id: "lint", label: "Lint" }]);
    expect(registry.byId.get("lint")).toEqual({ id: "lint", label: "Lint" });
  });

  it("rejects duplicate registry entries", () => {
    expect(() => createRegistry([{ id: "lint" }, { id: "lint" }])).toThrow(
      "Duplicate registry entry 'lint'.",
    );
  });

  it("ranks lizard maintainability from parsed function metrics", async () => {
    const project = await createTempSourceFile(["a", "b", "c", "d"].join("\n"));

    const metrics = await parseLizardMetrics("0,7,0,0,0,0,fixture.ts,work,1,1,2", project.root, [
      project.file,
    ]);

    expect(metrics[project.file]?.maintainability.rank).toBe("C");
  });

  it("ranks lizard complexity from parsed function metrics", async () => {
    const project = await createTempSourceFile("single\n");

    const metrics = await parseLizardMetrics("0,31,0,0,0,0,fixture.ts,work,1,1,2", project.root, [
      project.file,
    ]);

    expect(metrics[project.file]?.maxComplexity.rank).toBe("E");
  });

  it("keeps lizard function metrics needed for default threshold enforcement", async () => {
    const project = await createTempSourceFile("single\n");

    const metrics = await parseLizardMetrics(
      "201,11,0,7,0,0,fixture.ts,work,1,23,24",
      project.root,
      [project.file],
    );

    expect(metrics[project.file]?.blocks).toEqual([
      {
        complexity: 11,
        file: project.file,
        name: "work",
        nloc: 201,
        parameterCount: 7,
        startLine: 23,
      },
    ]);
  });
});
