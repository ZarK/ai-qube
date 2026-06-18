import { describe, expect, it } from "vitest";
import { fixtureFile, runEngine } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("runs TypeScript typecheck against the fixture project", async () => {
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["typecheck"],
      writeArtifacts: false,
    });

    expect(result.ok).toBe(true);
    expect(result.summary.diagnosticCount).toBe(0);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("passed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({
      stageId: "typecheck",
      status: "passed",
    });
    expect(result.stages[0]?.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "tsc",
    });
  });
});
