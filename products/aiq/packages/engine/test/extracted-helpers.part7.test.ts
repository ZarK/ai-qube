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
  it("falls back safely when a single-quoted pytest path contains an apostrophe", async () => {
    const project = await createTempSourceFile("placeholder\n");

    const report = parsePytestReport(
      [
        '<testsuite tests="1" failures="1" errors="0" skipped="0">',
        '  <testcase classname="tests.test_example" name="test_example">',
        "    <failure message=\"AssertionError\">File '.\\tests\\can&apos;t.py', line 17, in test_example",
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
        file: project.root,
        message: expect.stringContaining("can't.py"),
        severity: "error",
        source: "pytest",
      }),
    ]);
    expect(report.diagnostics[0]?.range).toBeUndefined();
  });

  it("parses double-quoted pytest paths containing apostrophes", async () => {
    const project = await createTempSourceFile("placeholder\n");
    const windowsFile = path.win32.normalize("C:/repo/tests/can't.py");

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

  it("parses Windows dotnet TRX stack traces", async () => {
    const project = await createTempSourceFile("placeholder\n");
    const windowsFile = path.win32.normalize("C:/repo/tests/Sample Tests.cs");

    const report = parseDotNetTrxReport(
      [
        "<TestRun>",
        '  <ResultSummary><Counters total="1" passed="0" failed="1" /></ResultSummary>',
        "  <Results>",
        '    <UnitTestResult testId="test-id" testName="Fails" outcome="Failed">',
        "      <Output><ErrorInfo>",
        "        <Message>Expected true but was false.</Message>",
        `        <StackTrace>at Tests.SampleTests.Fails() in ${windowsFile}:line 27</StackTrace>`,
        "      </ErrorInfo></Output>",
        "    </UnitTestResult>",
        "  </Results>",
        "  <TestDefinitions>",
        '    <UnitTest id="test-id">',
        '      <TestMethod codeBase="file:///C:/repo/bin/Debug/net10.0/SampleTests.dll" />',
        "    </UnitTest>",
        "  </TestDefinitions>",
        "</TestRun>",
      ].join("\n"),
      project.root,
    );

    expect(report.summary).toEqual({ failed: 1, passed: 0, total: 1 });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        file: windowsFile,
        range: { startColumn: 1, startLine: 27 },
        severity: "error",
        source: "dotnet-test",
      }),
    ]);
  });

  it("parses Windows UNC dotnet TRX stack traces", async () => {
    const project = await createTempSourceFile("placeholder\n");
    const windowsFile = path.win32.normalize("//server/share/tests/Sample Tests.cs");

    const report = parseDotNetTrxReport(
      [
        "<TestRun>",
        '  <ResultSummary><Counters total="1" passed="0" failed="1" /></ResultSummary>',
        "  <Results>",
        '    <UnitTestResult testId="test-id" testName="Fails" outcome="Failed">',
        "      <Output><ErrorInfo>",
        "        <Message>Expected true but was false.</Message>",
        `        <StackTrace>at Tests.SampleTests.Fails() in ${windowsFile}:line 27</StackTrace>`,
        "      </ErrorInfo></Output>",
        "    </UnitTestResult>",
        "  </Results>",
        "  <TestDefinitions>",
        '    <UnitTest id="test-id">',
        '      <TestMethod codeBase="file:///C:/repo/bin/Debug/net10.0/SampleTests.dll" />',
        "    </UnitTest>",
        "  </TestDefinitions>",
        "</TestRun>",
      ].join("\n"),
      project.root,
    );

    expect(report.summary).toEqual({ failed: 1, passed: 0, total: 1 });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        file: windowsFile,
        range: { startColumn: 1, startLine: 27 },
        severity: "error",
        source: "dotnet-test",
      }),
    ]);
  });
});
