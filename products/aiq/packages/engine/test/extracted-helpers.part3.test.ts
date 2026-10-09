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
import { parsePytestReport, parseTyGitlabDiagnostics } from "../src/parsers/python.js";
import { capitalize, resolveDiagnosticFile } from "../src/parsers/utils.js";
import { parseXmlAttributes } from "../src/parsers/xml.js";
import { createRegistry } from "../src/registries.js";
import {
  createRunnerExecutionContext,
  runnerExecutionContextStorage,
} from "../src/runner-context.js";
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

async function createTempSourceFile(
  contents: string,
  extension = ".ts",
): Promise<{ file: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-extracted-helpers-"));
  tempDirs.push(root);

  const file = path.join(root, `fixture${extension}`);
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
    {
      name: "Rust lifetime parameters",
      extension: ".rs",
      source: "fn identity<'a>(value: &'a str) -> &'a str {\n    // comment\n    value\n}",
      sloc: 3,
    },
    {
      name: "Rust static lifetimes followed by comments",
      extension: ".rs",
      source: ['const NAME: &\'static str = "x";', ...Array(350).fill("// comment")].join("\n"),
      sloc: 1,
    },
    {
      name: "nested Rust block comments",
      extension: ".rs",
      source: "/* outer\n /* inner */\n still a comment\n */\nfn work() {}",
      sloc: 1,
    },
    {
      name: "Rust loop labels and anonymous lifetimes",
      extension: ".rs",
      source:
        "'outer: loop {\n // comment\n let value: &'_ str = \"text\";\n break 'outer;\n}\n// comment",
      sloc: 4,
    },
    ...[".rs", ".java", ".cs", ".go", ".kt"].map((extension) => ({
      name: `${extension} character literals`,
      extension,
      source: "const chars = ['a', '/', '\\'', '\\\\'];\n// comment\nconst value = 1;",
      sloc: 2,
    })),
    {
      name: "Rust Unicode character literals",
      extension: ".rs",
      source: "let chars = ['🦀', '\\u{1F980}', '\\x27'];\n// comment\nlet value = 1;",
      sloc: 2,
    },
    {
      name: "non-nesting Java block comments",
      extension: ".java",
      source: "/* outer\n /* inner */\n class Main {}",
      sloc: 1,
    },
  ])("counts $name as source lines", async ({ extension, source, sloc }) => {
    const project = await createTempSourceFile(source, extension);
    const metrics = await parseLizardMetrics("", project.root, [project.file]);
    expect(metrics[project.file]?.raw.sloc).toBe(sloc);
    const context = createRunnerExecutionContext(project.root);
    context.stageConfigurations = { sloc: { languages: {}, limit: sloc + 1 } };
    runnerExecutionContextStorage.run(context, () => {
      expect(createLizardMetricsDiagnostics(metrics, "sloc", "lizard")).toEqual([]);
    });
  });

  it("counts the whole file independently of function NLOC", async () => {
    const project = await createTempSourceFile(
      `${Array.from({ length: 350 }, () => "line").join("\n")}\n`,
    );
    const metrics = await parseLizardMetrics("20,1,0,0,0,0,fixture.ts,work,1,23,24", project.root, [
      project.file,
    ]);

    expect(metrics[project.file]?.raw.sloc).toBe(350);
    expect(createLizardMetricsDiagnostics(metrics, "sloc", "lizard")).toHaveLength(1);
  });

  it("counts declarations and nested functions once and excludes comments and blank lines", async () => {
    const project = await createTempSourceFile(
      [
        "// header",
        "const answer = 42;",
        "",
        "/* block",
        " * comment */",
        "function outer() {",
        "  function inner() {",
        "    return answer; // comment",
        "  }",
        "  return inner();",
        "}",
        'const url = "https://example.com/*value*/";',
      ].join("\n"),
    );
    const metrics = await parseLizardMetrics(
      ["6,1,0,0,0,0,fixture.ts,outer,1,6,11", "3,1,0,0,0,0,fixture.ts,inner,1,7,9"].join("\n"),
      project.root,
      [project.file],
    );
    expect(metrics[project.file]?.raw.sloc).toBe(8);
    expect(metrics[project.file]?.blockCount).toBe(2);
  });

  it("recognizes regular expressions and comments inside template expressions", async () => {
    const project = await createTempSourceFile(
      [
        "const pattern = /[\"']/;",
        "// comment after a regular expression",
        "const url = /https?:\\/\\//;",
        "/* comment after escaped slashes */",
        "const template = `value ${",
        "  // interpolation comment",
        "  42",
        "}`;",
        "const text = `// literal text",
        "/* literal text */`;",
        "/** documentation */",
      ].join("\n"),
    );
    const metrics = await parseLizardMetrics("", project.root, [project.file]);
    expect(metrics[project.file]?.raw.sloc).toBe(7);
  });

  it.each([349, 350])("enforces the SLOC boundary at %i source lines", async (lines) => {
    const project = await createTempSourceFile(
      Array.from({ length: lines }, () => "const value = 1;").join("\n"),
    );
    const metrics = await parseLizardMetrics("", project.root, [project.file]);
    expect(createLizardMetricsDiagnostics(metrics, "sloc", "lizard")).toHaveLength(
      lines === 350 ? 1 : 0,
    );
  });

  it.each([
    "garbage",
    "20,1,broken,0,0,0,fixture.ts,work,1,2,3",
    "20,1,0,0,broken,0,fixture.ts,work,1,2,3",
    "20,1,0,0,0,0,fixture.ts,work,1,2,broken",
    "20,1,0,0,0,0,fixture.ts,work,1,3,2",
    "20broken,1,0,0,0,0,fixture.ts,work,1,2,3",
    "20,NaN,0,0,0,0,fixture.ts,work,1,2,3",
    '20,1,0,0,0,0,fixture.ts,"work,1,2,3',
  ])("rejects malformed Lizard output: %s", async (output) => {
    const project = await createTempSourceFile("function work() {}\n");
    await expect(parseLizardMetrics(output, project.root, [project.file])).rejects.toThrow(
      /Lizard/u,
    );
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

  it("uses the configured SLOC limit as the canonical repository setting", () => {
    const context = createRunnerExecutionContext(process.cwd());
    context.stageConfigurations = { sloc: { languages: {}, limit: 800 } };
    runnerExecutionContextStorage.run(context, () => {
      expect(readMetricsThresholds({ AIQ_SLOC_LIMIT: "500" }).slocLimit).toBe(800);
      const metrics = (sloc: number) => ({
        "fixture.ts": {
          blocks: [],
          blockCount: 0,
          maintainability: { rank: "A", score: 100 },
          maxComplexity: { rank: "A", score: 0 },
          raw: { sloc },
        },
      });
      expect(createLizardMetricsDiagnostics(metrics(799), "sloc", "lizard")).toEqual([]);
      expect(createLizardMetricsDiagnostics(metrics(800), "sloc", "lizard")).toHaveLength(1);
    });
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
