import { describe, expect, it } from "vitest";
import {
  createJavaMavenFixtureProject,
  hasMavenToolchain,
  runPlannedTask,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasMavenToolchain)(
    "runs Maven lint for Java projects",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-lint-runner-");

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:lint-java-maven",
          stageId: "lint",
        },
        process.cwd(),
      );

      expect(result.status).toBe("passed");
      expect(result.diagnostics).toEqual([]);
      expect(result.notes[0]).toContain("Maven Spotless");
      expect(result.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-spotless",
      });
    },
    120_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs Maven typecheck and parses compiler diagnostics for Java projects",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-typecheck-runner-");

      await writeFile(
        project.sourceFile,
        [
          "package dev.aiq.fixture;",
          "",
          "public final class Greeting {",
          "  private Greeting() {}",
          "",
          "  public static String message(String name) {",
          "    return 42;",
          "  }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:typecheck-java-maven",
          stageId: "typecheck",
        },
        process.cwd(),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "maven-build",
      });
      expect(result.diagnostics[0]?.message).toContain("incompatible types");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "maven-build",
      });
    },
    120_000,
  );

  it.skipIf(!hasMavenToolchain)(
    "runs Maven unit tests and coverage for Java projects",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-test-runner-");

      const unit = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:unit-java-maven",
          stageId: "unit",
        },
        process.cwd(),
      );
      const coverage = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:coverage-java-maven",
          stageId: "coverage",
        },
        process.cwd(),
      );

      expect(unit.status).toBe("passed");
      expect(unit.notes[0]).toContain("Maven test ran");
      expect(unit.toolRuns[0]).toMatchObject({ exitCode: 0, status: "passed", tool: "maven-test" });
      expect(coverage.status).toBe("passed");
      expect(coverage.notes[0]).toContain("Maven coverage lines:");
      expect(coverage.toolRuns[0]).toMatchObject({
        exitCode: 0,
        status: "passed",
        tool: "maven-test-coverage",
      });
    },
    120_000,
  );
});
