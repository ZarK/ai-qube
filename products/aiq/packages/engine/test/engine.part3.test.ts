import { describe, expect, it } from "vitest";
import { createRunPlan, fixtureFile, path } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("creates a versioned plan with requested stages", async () => {
    const plan = await createRunPlan({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "plan",
      stages: ["lint"],
      profile: "fast",
    });

    expect(plan.artifactType).toBe("plan");
    expect(plan.artifactVersion).toBe(1);
    expect(plan.artifacts.outDir).toBe(path.resolve(process.cwd(), ".qube/aiq/out"));
    expect(plan.context).toBe("cli");
    expect(plan.engineVersion).toBe("0.0.0");
    expect(plan.input.files).toEqual([fixtureFile]);
    expect(plan.input.summary.fileCount).toBe(1);
    expect(plan.stages).toEqual(["lint"]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      fileCount: 1,
      stageId: "lint",
    });
    expect(plan.summary).toEqual({
      fileCount: 1,
      stageCount: 1,
      taskCount: 1,
    });
  });
});
