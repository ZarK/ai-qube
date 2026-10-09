import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLizardMetricsDiagnostics,
  createPythonMetricsDiagnostics,
  metricsDiagnosticCodes,
  readMetricsThresholds,
} from "../src/metrics-thresholds.js";
import { parseDotNetTrxReport } from "../src/parsers/dotnet.js";
import { parseGoVetDiagnostics } from "../src/parsers/go.js";
import { parseLizardMetrics } from "../src/parsers/lizard.js";
import {
  parsePytestReport,
  parsePythonMetrics,
  parseTyGitlabDiagnostics,
} from "../src/parsers/python.js";
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
  it.each([
    "",
    "not JSON",
    "[]",
    '{"fixture.py": null}',
    '{"fixture.py": {}}',
    '{"fixture.py": {"cc": [], "mi": {"rank": "A", "score": "unknown"}, "raw": {}}}',
  ])("rejects malformed Python metrics: %s", (output) => {
    expect(() => parsePythonMetrics(output)).toThrow(/radon/iu);
  });

  it("rejects incomplete or invalid Python metric fields", () => {
    const valid = {
      cc: [
        {
          complexity: 1,
          endline: 2,
          lineno: 1,
          name: "work",
          rank: "A",
          type: "Function",
        },
      ],
      mi: { rank: "A", score: 100 },
      raw: {
        blank: 0,
        comments: 0,
        lloc: 2,
        loc: 2,
        multi: 0,
        singleComments: 0,
        sloc: 2,
      },
      readability: { score: 100 },
    };
    expect(parsePythonMetrics(JSON.stringify({ "fixture.py": valid }))["fixture.py"]).toEqual(
      valid,
    );
    for (const invalid of [
      { ...valid, cc: [{}] },
      { ...valid, cc: null },
      { ...valid, raw: { ...valid.raw, sloc: "2" } },
      { ...valid, raw: { ...valid.raw, sloc: -1 } },
      { ...valid, raw: { ...valid.raw, sloc: 1.5 } },
      { ...valid, cc: [{ ...valid.cc[0], complexity: -1 }] },
      { ...valid, readability: { score: null } },
      { ...valid, mi: { score: 100 } },
    ]) {
      expect(() => parsePythonMetrics(JSON.stringify({ "fixture.py": invalid }))).toThrow(
        /Malformed Radon/u,
      );
    }
    for (const score of ["1e309", "-1e309"]) {
      const report = JSON.stringify({ "fixture.py": valid }).replace(
        '"readability":{"score":100}',
        `"readability":{"score":${score}}`,
      );
      expect(() => parsePythonMetrics(report)).toThrow("score must be a finite number.");
    }
  });

  it("accepts negative readability without rejecting source line or complexity measurements", () => {
    const metrics = parsePythonMetrics(
      JSON.stringify({
        "fixture.py": {
          cc: [],
          mi: { rank: "A", score: 100 },
          raw: { blank: 0, comments: 0, lloc: 40, loc: 40, multi: 0, singleComments: 0, sloc: 40 },
          readability: { score: -22 },
        },
      }),
    );
    expect(metrics["fixture.py"]).toMatchObject({
      cc: [],
      raw: { sloc: 40 },
      readability: { score: -22 },
    });
    expect(createPythonMetricsDiagnostics(metrics, "sloc", "radon")).toEqual([]);
    expect(createPythonMetricsDiagnostics(metrics, "complexity", "radon")).toEqual([]);
    expect(createPythonMetricsDiagnostics(metrics, "maintainability", "radon")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.pythonReadability,
        message: "Readability index -22.0 is less than 85.",
      }),
    ]);
  });

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

  it("applies per-method maintainability limits to C#", () => {
    const file = path.resolve("fixture.cs");
    const metrics = {
      [file]: {
        blockCount: 1,
        blocks: [
          { complexity: 11, file, name: "Score", nloc: 10, parameterCount: 1, startLine: 1 },
        ],
        maintainability: { rank: "A", score: 100 },
        maxComplexity: { rank: "C", score: 11 },
        raw: { sloc: 10 },
      },
    };

    expect(createLizardMetricsDiagnostics(metrics, "maintainability", "lizard")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.lizardMaintainabilityComplexity,
        file,
        message: "Score maintainability complexity 11 is greater than 10.",
      }),
    ]);
  });
});
