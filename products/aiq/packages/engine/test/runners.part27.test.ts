import { describe, expect, it } from "vitest";
import { createGoFixtureProject, runPlannedTask, writeFile } from "./runners-test-support.js";

const fakeGitHubToken = ["ghp", "123456789012345678901234567890123456"].join("_");

describe("engine runners", () => {
  it("reuses cached Go metrics between sloc, complexity, and maintainability", async () => {
    const project = await createGoFixtureProject("aiq-go-metrics-runner-");

    const sloc = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:sloc-go",
        stageId: "sloc",
      },
      process.cwd(),
    );
    const complexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-go",
        stageId: "complexity",
      },
      process.cwd(),
    );
    const maintainability = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:maintainability-go",
        stageId: "maintainability",
      },
      process.cwd(),
    );

    expect(sloc.status).toBe("passed");
    expect(sloc.notes[0]).toContain("Go SLOC:");
    expect(sloc.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
    expect(complexity.status).toBe("passed");
    expect(complexity.notes[0]).toContain("Shared metrics observed");
    expect(complexity.notes.join(" ")).toContain("Reused cached Go metrics");
    expect(complexity.toolRuns[0]).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
    expect(maintainability.status).toBe("passed");
    expect(maintainability.notes.join(" ")).toContain("Reused cached Go metrics");
    expect(maintainability.toolRuns[0]).toMatchObject({
      cacheHit: true,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
  }, 20_000);

  it("runs the shared security scan for Go inputs", async () => {
    const project = await createGoFixtureProject("aiq-go-security-runner-");

    await writeFile(
      project.sourceFile,
      ["package fixture", "", `const token = "${fakeGitHubToken}"`, ""].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:security-go",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "aiq-security",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });
});
