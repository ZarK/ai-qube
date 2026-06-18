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
});
