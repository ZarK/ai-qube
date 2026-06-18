import { describe, expect, it } from "vitest";
import {
  createGoFixtureProject,
  hasGoToolchain,
  runPlannedTask,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasGoToolchain)(
    "marks Go lint as failed when go vet exits non-zero without parseable diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-lint-fallback-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          "func Greet(name string) string {",
          '    return "Hello, " + name + "!"',
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:lint-go-fallback-diagnostic",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "go-vet",
      });
      expect(result.notes[0]).toContain("reported 1 diagnostic");
      expect(result.notes[0]).not.toContain("passed for");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "go-vet",
      });
    },
    20_000,
  );

  it.skipIf(!hasGoToolchain)(
    "runs Go format and reports formatting diagnostics",
    async () => {
      const project = await createGoFixtureProject("aiq-go-format-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package fixture",
          "",
          'import "strings"',
          "",
          "func Greet(name string) string{",
          "trimmedName := strings.TrimSpace(name)",
          'return "Hello, " + trimmedName + "!"',
          "}",
          "",
          "func Sum(values []int) int {",
          "total := 0",
          "for _, value := range values {",
          "total += value",
          "}",
          "return total",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:format-go",
          stageId: "format",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "gofmt",
      });
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "failed",
        tool: "gofmt",
      });
    },
    20_000,
  );
});
