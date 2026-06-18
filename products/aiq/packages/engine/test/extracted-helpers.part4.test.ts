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
  it("fails Python SLOC, complexity, maintainability, and readability defaults", () => {
    const file = path.resolve("fixture.py");
    const metrics = {
      [file]: {
        cc: [
          {
            complexity: 11,
            endline: 12,
            lineno: 4,
            name: "work",
            rank: "C",
            type: "Function",
          },
        ],
        mi: {
          rank: "C",
          score: 39,
        },
        raw: {
          blank: 0,
          comments: 0,
          lloc: 0,
          loc: 350,
          multi: 0,
          singleComments: 0,
          sloc: 350,
        },
        readability: {
          score: 84,
        },
      },
    };

    expect(createPythonMetricsDiagnostics(metrics, "sloc", "radon")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.sloc,
        file,
        message: "SLOC 350 is greater than or equal to 350.",
      }),
    ]);
    expect(createPythonMetricsDiagnostics(metrics, "complexity", "radon")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.pythonComplexity,
        file,
        message: "work complexity rank C is not allowed; only A/B complexity ranks pass.",
      }),
    ]);
    expect(createPythonMetricsDiagnostics(metrics, "maintainability", "radon")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.pythonMaintainability,
        file,
        message: "Maintainability index 39.0 is less than 40.",
      }),
      expect.objectContaining({
        code: metricsDiagnosticCodes.pythonReadability,
        file,
        message: "Readability index 84.0 is less than 85.",
      }),
    ]);
  });

  it("uses lizard-style complexity defaults for file-level metric fallbacks", () => {
    const file = path.resolve("fixture.cs");
    const metrics = {
      [file]: {
        maintainability: { score: 100 },
        maxComplexity: { score: 11 },
        raw: { sloc: 10 },
      },
    };

    expect(createFileMetricDiagnostics(metrics, "maintainability", "aiq-csharp-metrics")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.lizardMaintainabilityComplexity,
        file,
        message: "Maintainability complexity 11 is greater than 10.",
      }),
    ]);
  });
});
