import { describe, expect, it } from "vitest";
import {
  createGoFixtureProject,
  createRustFixtureProject,
  hasRustToolchain,
  runPlannedTask,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasRustToolchain)(
    "reuses cached Rust metrics between sloc, complexity, and maintainability",
    async () => {
      const project = await createRustFixtureProject("aiq-rust-metrics-runner-");

      const sloc = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:sloc-rust",
          stageId: "sloc",
        },
        process.cwd(),
      );
      const complexity = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:complexity-rust",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.sourceFile],
          id: "test:1:maintainability-rust",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(sloc.status).toBe("passed");
      expect(sloc.notes[0]).toContain("Rust SLOC:");
      expect(sloc.toolRuns[0]).toMatchObject({
        cacheHit: false,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(complexity.status).toBe("passed");
      expect(complexity.notes[0]).toContain("Shared metrics observed");
      expect(complexity.notes.join(" ")).toContain("Reused cached Rust metrics");
      expect(complexity.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached Rust metrics");
      expect(maintainability.toolRuns[0]).toMatchObject({
        cacheHit: true,
        exitCode: 0,
        status: "passed",
        tool: "lizard",
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "combines Go and Rust metrics without downgrading supported mixed selections",
    async () => {
      const goProject = await createGoFixtureProject("aiq-mixed-go-rust-metrics-runner-");
      const rustProject = await createRustFixtureProject("aiq-mixed-go-rust-metrics-runner-");

      const complexity = await runPlannedTask(
        {
          fileCount: 2,
          files: [goProject.sourceFile, rustProject.sourceFile],
          id: "test:1:complexity-mixed-go-rust",
          stageId: "complexity",
        },
        process.cwd(),
      );
      const maintainability = await runPlannedTask(
        {
          fileCount: 2,
          files: [goProject.sourceFile, rustProject.sourceFile],
          id: "test:1:maintainability-mixed-go-rust",
          stageId: "maintainability",
        },
        process.cwd(),
      );

      expect(complexity.status).toBe("passed");
      expect(complexity.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "lizard" }),
          expect.objectContaining({ cacheHit: false, status: "passed", tool: "lizard" }),
        ]),
      );
      expect(maintainability.status).toBe("passed");
      expect(maintainability.notes.join(" ")).toContain("Reused cached");
    },
    20_000,
  );
});
