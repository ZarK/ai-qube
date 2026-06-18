import { describe, expect, it } from "vitest";
import {
  createJavaMavenFixtureProject,
  hasMavenToolchain,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasMavenToolchain)(
    "reuses cached JVM metrics between sloc, complexity, and maintainability",
    async () => {
      const project = await createJavaMavenFixtureProject("aiq-java-maven-metrics-runner-");

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:sloc-java-maven",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:complexity-java-maven",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:maintainability-java-maven",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("JVM SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached JVM metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached JVM metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
    },
    120_000,
  );
});
