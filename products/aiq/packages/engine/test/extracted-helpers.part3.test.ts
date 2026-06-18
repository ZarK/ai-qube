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
  it("uses lizard aggregate function NLOC for SLOC diagnostics", async () => {
    const project = await createTempSourceFile(
      `${Array.from({ length: 350 }, () => "line").join("\n")}\n`,
    );
    const metrics = await parseLizardMetrics("20,1,0,0,0,0,fixture.ts,work,1,23,24", project.root, [
      project.file,
    ]);

    expect(metrics[project.file]?.raw.sloc).toBe(20);
    expect(createLizardMetricsDiagnostics(metrics, "sloc", "lizard")).toEqual([]);
  });

  it("fails lizard-backed SLOC, complexity, and maintainability defaults", async () => {
    const project = await createTempSourceFile(
      `${Array.from({ length: 350 }, () => "line").join("\n")}\n`,
    );
    const metrics = await parseLizardMetrics(
      "350,13,0,7,0,0,fixture.ts,work,1,23,24",
      project.root,
      [project.file],
    );

    expect(createLizardMetricsDiagnostics(metrics, "sloc", "lizard")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.sloc,
        file: project.file,
        message: "SLOC 350 is greater than or equal to 350.",
        source: "lizard",
      }),
    ]);
    expect(createLizardMetricsDiagnostics(metrics, "complexity", "lizard")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.lizardComplexity,
        file: project.file,
        message: "work complexity 13 is greater than 12.",
        source: "lizard",
      }),
    ]);
    expect(createLizardMetricsDiagnostics(metrics, "maintainability", "lizard")).toEqual([
      expect.objectContaining({
        code: metricsDiagnosticCodes.lizardMaintainabilityComplexity,
        file: project.file,
        message: "work maintainability complexity 13 is greater than 10.",
      }),
      expect.objectContaining({
        code: metricsDiagnosticCodes.lizardMaintainabilityFunctionNloc,
        file: project.file,
        message: "work function NLOC 350 is greater than 200.",
      }),
      expect.objectContaining({
        code: metricsDiagnosticCodes.lizardMaintainabilityParameterCount,
        file: project.file,
        message: "work parameter count 7 is greater than 6.",
      }),
    ]);
  });

  it("honors metrics threshold environment overrides", () => {
    expect(
      readMetricsThresholds({
        AIQ_SLOC_LIMIT: "500",
        LIZARD_CCN_LIMIT: "20",
        LIZARD_CCN_STRICT: "18",
        LIZARD_FN_NLOC_LIMIT: "400",
        LIZARD_PARAM_LIMIT: "9",
      }).slocLimit,
    ).toBe(500);
    expect(
      readMetricsThresholds({
        AIQ_SLOC_LIMIT: "500",
        LIZARD_CCN_LIMIT: "20",
        LIZARD_CCN_STRICT: "18",
        LIZARD_FN_NLOC_LIMIT: "400",
        LIZARD_PARAM_LIMIT: "9",
      }),
    ).toMatchObject({
      lizardComplexityLimit: 20,
      lizardMaintainabilityComplexityLimit: 18,
      lizardMaintainabilityFunctionNlocLimit: 400,
      lizardMaintainabilityParameterLimit: 9,
      slocLimit: 500,
    });
  });
});
