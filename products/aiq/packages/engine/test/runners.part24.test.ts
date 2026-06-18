import { describe, expect, it } from "vitest";
import {
  createCustomPythonRunnerProject,
  createGoFixtureProject,
  hasGoToolchain,
  path,
  readFile,
  runPlannedTask,
  withPathedPythonShim,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("does not reuse Python coverage executions across standalone runner calls", async () => {
    const project = await createCustomPythonRunnerProject({
      prefix: "aiq-python-no-cross-run-reuse-",
      runnerScript: [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'const junitPath = args[args.indexOf("--junitxml") + 1];',
        'const coverageArgIndex = args.indexOf("--cov-report");',
        "const coverageArg = coverageArgIndex >= 0 ? args[coverageArgIndex + 1] : undefined;",
        'const coveragePath = coverageArg && coverageArg.startsWith("json:") ? coverageArg.slice("json:".length) : undefined;',
        'const countFile = path.join(process.cwd(), "invocations.txt");',
        'const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;',
        "fs.writeFileSync(countFile, String(count));",
        'fs.writeFileSync(junitPath, \'<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\');',
        "if (coveragePath) {",
        "  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });",
        "  fs.writeFileSync(coveragePath, JSON.stringify({ totals: { percent_covered: 100 } }));",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    });

    const [coverageResult, unitResult] = await withPathedPythonShim(project.shimDir, async () => [
      await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-python-no-cross-run-reuse",
          stageId: "coverage",
        },
        project.root,
      ),
      await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-python-no-cross-run-reuse",
          stageId: "unit",
        },
        project.root,
      ),
    ]);

    expect(coverageResult.status).toBe("passed");
    expect(coverageResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "pytest-cov" });
    expect(unitResult.status).toBe("passed");
    expect(unitResult.toolRuns[0]).toMatchObject({ cacheHit: false, tool: "pytest" });
    expect(await readFile(path.join(project.root, "invocations.txt"), "utf8")).toBe("2");
  });

  it.skipIf(!hasGoToolchain)(
    "runs Go lint and returns structured diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-lint-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          'import "fmt"',
          "",
          "func Greet(name string) string {",
          '    fmt.Printf("%d", name)',
          '    return "Hello, " + name + "!"',
          "}",
          "",
          "func Sum(values []int) int {",
          "    total := 0",
          "    for _, value := range values {",
          "        total += value",
          "    }",
          "",
          "    return total",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:lint-go",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "printf",
        file: project.sourceFile,
        severity: "error",
        source: "go-vet",
      });
      expect(result.diagnostics[0]?.message).toContain("fmt.Printf format %d has arg name");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "go-vet",
      });
    },
    20_000,
  );
});
