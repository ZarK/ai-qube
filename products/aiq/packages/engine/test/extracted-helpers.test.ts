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
  it("parses XML attributes with flexible quoting and spacing", () => {
    expect(parseXmlAttributes("name = 'alpha' count=\"2\" label = 'a &amp; b'")).toEqual({
      count: "2",
      label: "a & b",
      name: "alpha",
    });
  });

  it("capitalizes empty strings safely", () => {
    expect(capitalize("")).toBe("");
    expect(capitalize("stage")).toBe("Stage");
  });

  it("builds Terraform init args from explicit disable flags", () => {
    expect(createTerraformInitArgs()).toEqual(["init", "-no-color"]);
    expect(createTerraformInitArgs({ disableBackend: true, disableInput: true })).toEqual([
      "init",
      "-backend=false",
      "-input=false",
      "-no-color",
    ]);
  });

  it("builds native config args for tools that accept explicit config paths", () => {
    expect(
      createBiomeLintArgs({ configPath: "/repo/biome.json", files: ["src/index.ts"] }),
    ).toEqual(["lint", "--config-path=/repo/biome.json", "--reporter=json", "src/index.ts"]);
    expect(createPlaywrightTestArgs({ configPath: "/repo/playwright.config.ts" })).toEqual([
      "test",
      "--config",
      "/repo/playwright.config.ts",
      "--reporter=json",
    ]);
  });

  it("builds ty args with gitlab output enabled", () => {
    expect(
      createTyCheckArgs({
        files: ["main.py", "tests/test_main.py"],
        pythonPath: "/usr/bin/python3",
      }),
    ).toEqual([
      "check",
      "--python",
      "/usr/bin/python3",
      "--output-format",
      "gitlab",
      "--no-progress",
      "--color",
      "never",
      "main.py",
      "tests/test_main.py",
    ]);
  });

  it("builds Python test args with explicit coverage plugin loading", () => {
    expect(
      createPythonTestArgs({
        coveragePath: "/tmp/coverage.json",
        junitPath: "/tmp/junit.xml",
        mode: "unit",
      }),
    ).toEqual(["-m", "pytest", "--junitxml", "/tmp/junit.xml", "-q"]);
    expect(
      createPythonTestArgs({
        coveragePath: "/tmp/coverage.json",
        junitPath: "/tmp/junit.xml",
        mode: "coverage",
      }),
    ).toEqual([
      "-m",
      "pytest",
      "--junitxml",
      "/tmp/junit.xml",
      "-q",
      "-p",
      "pytest_cov",
      "--cov=.",
      "--cov-report",
      "json:/tmp/coverage.json",
    ]);
  });

  it("builds direct JavaScript test args without the npm wrapper", () => {
    expect(
      createDirectJavaScriptTestArgs({
        coverageDirectory: "/tmp/coverage",
        mode: "coverage",
        reportPath: "/tmp/report.json",
        runner: "vitest",
      }),
    ).toEqual([
      "--passWithNoTests",
      "--reporter=json",
      "--outputFile=/tmp/report.json",
      "--run",
      "--pool=threads",
      "--poolOptions.threads.maxThreads=1",
      "--poolOptions.threads.minThreads=1",
      "--no-file-parallelism",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reportsDirectory=/tmp/coverage",
      "--coverage.reporter=json-summary",
    ]);
    expect(
      createJavaScriptTestArgs({
        coverageDirectory: "/tmp/coverage",
        mode: "coverage",
        reportPath: "/tmp/report.json",
        runner: "vitest",
      }),
    ).toEqual([
      "test",
      "--",
      "--passWithNoTests",
      "--reporter=json",
      "--outputFile=/tmp/report.json",
      "--run",
      "--pool=threads",
      "--poolOptions.threads.maxThreads=1",
      "--poolOptions.threads.minThreads=1",
      "--no-file-parallelism",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reportsDirectory=/tmp/coverage",
      "--coverage.reporter=json-summary",
    ]);
  });
});
