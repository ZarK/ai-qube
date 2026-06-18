import { describe, expect, it } from "vitest";
import { fixtureFile, fixtureJavaScriptFile, runEngine } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("uses configured stage language selections to limit shared JavaScript runners", async () => {
    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile, fixtureJavaScriptFile],
        source: "mixed",
      },
      mode: "check",
      stages: ["unit"],
      stageConfigurations: {
        unit: {
          languages: {
            typescript: {
              toolId: "javascript",
            },
          },
        },
      },
      writeArtifacts: false,
    });

    const unitStage = result.stages.find((stage) => stage.stageId === "unit");

    expect(result.ok).toBe(true);
    expect(unitStage).toMatchObject({ stageId: "unit", status: "passed" });
    expect(unitStage?.toolRuns).toEqual([
      expect.objectContaining({ exitCode: 0, status: "passed", tool: "vitest" }),
    ]);
    expect(unitStage?.notes.join(" ")).toContain("Vitest ran");
    expect(unitStage?.notes.join(" ")).not.toContain("Jest ran");
  });
});
