import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseDotNetTrxReport } from "../src/parsers/dotnet.js";
import { parseGoVetDiagnostics } from "../src/parsers/go.js";
import { parseLizardMetrics } from "../src/parsers/lizard.js";
import { parsePytestReport, parseTyGitlabDiagnostics } from "../src/parsers/python.js";
import { capitalize, resolveDiagnosticFile } from "../src/parsers/utils.js";
import { parseXmlAttributes } from "../src/parsers/xml.js";
import { createRegistry } from "../src/registries.js";
import {
  createDirectJavaScriptTestArgs,
  createJavaScriptTestArgs,
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

  it("preserves the previous lizard maintainability thresholds", async () => {
    const project = await createTempSourceFile(["a", "b", "c", "d"].join("\n"));

    const metrics = await parseLizardMetrics("0,7,0,0,0,0,fixture.ts", project.root, [
      project.file,
    ]);

    expect(metrics[project.file]?.maintainability.rank).toBe("C");
  });

  it("preserves the previous lizard complexity thresholds", async () => {
    const project = await createTempSourceFile("single\n");

    const metrics = await parseLizardMetrics("0,31,0,0,0,0,fixture.ts", project.root, [
      project.file,
    ]);

    expect(metrics[project.file]?.maxComplexity.rank).toBe("E");
  });

  it("parses multi-object go vet json-lines output", async () => {
    const project = await createTempSourceFile("package fixture\n");
    const goFile = path.join(project.root, "fixture.go");
    await writeFile(goFile, "package fixture\n", "utf8");

    const diagnostics = parseGoVetDiagnostics(
      "",
      [
        JSON.stringify({
          "example.com/fixture": {
            printf: [
              {
                message: "first issue",
                posn: "fixture.go:3:4",
              },
            ],
          },
        }),
        JSON.stringify({
          "example.com/fixture": {
            shift: [
              {
                message: "second issue",
                posn: "fixture.go:7:2",
              },
            ],
          },
        }),
      ].join("\n"),
      project.root,
    );

    expect(diagnostics).toEqual([
      {
        code: "printf",
        file: goFile,
        message: "first issue",
        range: {
          startColumn: 4,
          startLine: 3,
        },
        severity: "error",
        source: "go-vet",
      },
      {
        code: "shift",
        file: goFile,
        message: "second issue",
        range: {
          startColumn: 2,
          startLine: 7,
        },
        severity: "error",
        source: "go-vet",
      },
    ]);
  });

  it("parses pretty-printed concatenated go vet json output", async () => {
    const project = await createTempSourceFile("package fixture\n");
    const goFile = path.join(project.root, "fixture.go");
    await writeFile(goFile, "package fixture\n", "utf8");

    const diagnostics = parseGoVetDiagnostics(
      "",
      [
        JSON.stringify({}, null, 2),
        JSON.stringify(
          {
            "example.com/fixture": {
              printf: [
                {
                  message: "fmt.Printf format %d has arg name of wrong type string",
                  posn: "fixture.go:6:17",
                },
              ],
            },
          },
          null,
          2,
        ),
      ].join("\n"),
      project.root,
    );

    expect(diagnostics).toEqual([
      {
        code: "printf",
        file: goFile,
        message: "fmt.Printf format %d has arg name of wrong type string",
        range: {
          startColumn: 17,
          startLine: 6,
        },
        severity: "error",
        source: "go-vet",
      },
    ]);
  });

  it("resolves Windows drive-letter file URIs safely", () => {
    expect(resolveDiagnosticFile("file:///C:/repo/tests/test%20example.py", "/tmp/project")).toBe(
      path.win32.normalize("C:/repo/tests/test example.py"),
    );
  });

  it("treats localhost file URIs as local paths", () => {
    expect(
      resolveDiagnosticFile("file://localhost/C:/repo/tests/test%20example.py", "/tmp/project"),
    ).toBe(path.win32.normalize("C:/repo/tests/test example.py"));
  });

  it("preserves UNC file URIs safely", () => {
    expect(
      resolveDiagnosticFile("file://server/share/tests/test%20example.py", "/tmp/project"),
    ).toBe(path.win32.normalize("//server/share/tests/test example.py"));
  });

  it("preserves Windows UNC paths safely", () => {
    expect(resolveDiagnosticFile("\\\\server\\share\\tests\\test_example.py", "/tmp/project")).toBe(
      path.win32.normalize("//server/share/tests/test_example.py"),
    );
  });

  it("resolves Windows-relative paths against cwd", () => {
    expect(resolveDiagnosticFile(".\\tests\\test_example.py", "/tmp/project")).toBe(
      path.resolve("/tmp/project", "tests/test_example.py"),
    );
  });

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
