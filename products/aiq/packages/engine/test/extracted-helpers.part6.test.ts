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
  it("parses Windows pytest traceback locations", async () => {
    const project = await createTempSourceFile("placeholder\n");
    const windowsFile = path.win32.normalize("C:/repo/tests/test_example.py");

    const report = parsePytestReport(
      [
        '<testsuite tests="1" failures="1" errors="0" skipped="0">',
        '  <testcase classname="tests.test_example" name="test_example">',
        `    <failure message="AssertionError">File &quot;${windowsFile}&quot;, line 17, in test_example`,
        "AssertionError",
        "    </failure>",
        "  </testcase>",
        "</testsuite>",
      ].join("\n"),
      project.root,
    );

    expect(report.summary).toEqual({ failed: 1, passed: 0, total: 1 });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        file: windowsFile,
        range: { startColumn: 1, startLine: 17 },
        severity: "error",
        source: "pytest",
      }),
    ]);
  });

  it("falls back to the description prefix when ty omits check_name", () => {
    const projectRoot = path.join(os.tmpdir(), "aiq-ty-parser-project");
    const diagnostics = parseTyGitlabDiagnostics(
      JSON.stringify([
        {
          description:
            "invalid-assignment: Object of type `Literal[42]` is not assignable to `str`",
          location: {
            path: "bad.py",
            positions: {
              begin: { column: 14, line: 1 },
              end: { column: 16, line: 1 },
            },
          },
          severity: "major",
        },
      ]),
      projectRoot,
    );

    expect(diagnostics).toEqual([
      {
        code: "invalid-assignment",
        file: path.join(projectRoot, "bad.py"),
        message: "invalid-assignment: Object of type `Literal[42]` is not assignable to `str`",
        range: {
          endColumn: 16,
          endLine: 1,
          startColumn: 14,
          startLine: 1,
        },
        severity: "error",
        source: "ty",
      },
    ]);
  });

  it("parses Windows-relative pytest traceback locations", async () => {
    const project = await createTempSourceFile("placeholder\n");

    const report = parsePytestReport(
      [
        '<testsuite tests="1" failures="1" errors="0" skipped="0">',
        '  <testcase classname="tests.test_example" name="test_example">',
        '    <failure message="AssertionError">File &quot;.\\tests\\test_example.py&quot;, line 17, in test_example',
        "AssertionError",
        "    </failure>",
        "  </testcase>",
        "</testsuite>",
      ].join("\n"),
      project.root,
    );

    expect(report.summary).toEqual({ failed: 1, passed: 0, total: 1 });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        file: path.resolve(project.root, "tests/test_example.py"),
        range: { startColumn: 1, startLine: 17 },
        severity: "error",
        source: "pytest",
      }),
    ]);
  });

  it("parses Windows-relative pytest traceback locations with spaces", async () => {
    const project = await createTempSourceFile("placeholder\n");

    const report = parsePytestReport(
      [
        '<testsuite tests="1" failures="1" errors="0" skipped="0">',
        '  <testcase classname="tests.test_example" name="test_example">',
        '    <failure message="AssertionError">File &quot;.\\tests\\my test.py&quot;, line 17, in test_example',
        "AssertionError",
        "    </failure>",
        "  </testcase>",
        "</testsuite>",
      ].join("\n"),
      project.root,
    );

    expect(report.summary).toEqual({ failed: 1, passed: 0, total: 1 });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        file: path.resolve(project.root, "tests/my test.py"),
        range: { startColumn: 1, startLine: 17 },
        severity: "error",
        source: "pytest",
      }),
    ]);
  });
});
