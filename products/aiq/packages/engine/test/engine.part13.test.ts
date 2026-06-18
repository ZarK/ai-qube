import { describe, expect, it } from "vitest";
import { fixtureFile, runEngine } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("treats configured stages with no enabled languages as a noop instead of not implemented", async () => {
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
    expect(result.summary.status).toBe("passed");
    expect(result.stages).toEqual([
      expect.objectContaining({
        diagnostics: [],
        stageId: "lint",
        status: "passed",
        toolRuns: [],
      }),
    ]);
    expect(result.stages[0]?.notes).toEqual(["No supported files were selected for lint."]);
  });
});
