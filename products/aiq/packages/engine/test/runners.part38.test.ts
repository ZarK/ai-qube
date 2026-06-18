import { describe, expect, it } from "vitest";
import {
  createKotlinGradleFixtureProject,
  hasGradleToolchain,
  runPlannedTask,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasGradleToolchain)(
    "runs Gradle format and unit stages for Kotlin projects",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-kotlin-gradle-runner-");

      const unit = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-kotlin-gradle",
          stageId: "unit",
        },
        process.cwd(),
      );

      await writeFile(
        project.sourceFile,
        [
          "package dev.aiq.fixture",
          "",
          "object Greeting{",
          "    fun message(name: String): String{",
          "        val trimmedName=name.trim()",
          '        return "Hello, $trimmedName!"',
          "    }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const format = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:format-kotlin-gradle",
          stageId: "format",
        },
        process.cwd(),
      );

      expect(unit.status).toBe("passed");
      expect(unit.notes[0]).toContain("Gradle test ran");
      expect(unit.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-test",
      });
      expect(format.status).toBe("failed");
      expect(format.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "gradle-spotless",
      });
      expect(format.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "gradle-spotless",
      });
    },
    180_000,
  );

  it.skipIf(!hasGradleToolchain)(
    "runs Gradle coverage for Kotlin projects",
    async () => {
      const project = await createKotlinGradleFixtureProject("aiq-kotlin-gradle-coverage-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-kotlin-gradle",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.notes[0]).toContain("Gradle coverage lines:");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "gradle-test-coverage",
      });
    },
    120_000,
  );
});
