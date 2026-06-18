import { describe, expect, it } from "vitest";
import {
  createGoFixtureProject,
  hasGoToolchain,
  runPlannedTask,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasGoToolchain)(
    "runs Go typecheck and parses compiler diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-typecheck-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          'import "strings"',
          "",
          "func Greet(name string) string {",
          "    trimmedName := strings.TrimSpace(name)",
          "    return 42 + len(trimmedName)",
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
          id: "test:1:typecheck-go",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "go-build",
      });
      expect(result.diagnostics[0]?.message).toContain("cannot use 42");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "go-build",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go unit tests for Go projects",
    async () => {
      const project = await createGoFixtureProject("aiq-go-unit-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-go",
          stageId: "unit",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("go test ran");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "go-test",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go coverage for Go projects",
    async () => {
      const project = await createGoFixtureProject("aiq-go-coverage-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-go",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("go test coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "go-test-coverage",
      });
    },
    20_000,
  );
});
