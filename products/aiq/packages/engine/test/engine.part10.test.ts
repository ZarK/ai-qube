import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  createJavaScriptFixtureProject,
  createToolRunOutcome,
  runEngine,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("reports missing project-managed JavaScript runner as setup guidance", async () => {
    const { root, sourceFile } = await createJavaScriptFixtureProject(
      "aiq-engine-js-missing-runner-",
    );
    vi.spyOn(ToolRunner.prototype, "run").mockResolvedValueOnce(
      createToolRunOutcome({ exitCode: undefined }),
    );

    const result = await runEngine({
      context: "cli",
      cwd: root,
      manifest: {
        files: [sourceFile],
        source: "direct",
      },
      mode: "check",
      stages: ["unit"],
      writeArtifacts: false,
    });

    const diagnostic = result.stages[0]?.diagnostics[0];

    expect(result.ok).toBe(false);
    expect(result.stages[0]).toMatchObject({
      stageId: "unit",
      status: "failed",
    });
    expect(diagnostic).toMatchObject({
      source: "jest",
      message: expect.stringContaining("Run aiq setup"),
    });
    expect(diagnostic?.message).not.toContain("spawn");
  });
});
