import { describe, expect, it } from "vitest";
import { fixtureFile, runEngine } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("warns when configured stages have no enabled analyzers", async () => {
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      stageConfigurations: {
        lint: {
          languages: {},
        },
      },
      writeArtifacts: false,
    });

    expect(result.ok).toBe(true);
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.summary.status).toBe("warning");
    expect(result.stages).toEqual([
      expect.objectContaining({
        diagnostics: [],
        stageId: "lint",
        status: "warning",
        toolRuns: [],
      }),
    ]);
    expect(result.stages[0]?.notes).toEqual(["No supported files were selected for lint."]);
  });
});
