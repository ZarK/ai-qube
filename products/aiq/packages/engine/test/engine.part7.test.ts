import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  createToolRunOutcome,
  createTypeScriptFixtureProject,
  runEngine,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("reports missing bundled TypeScript runner as setup guidance", async () => {
    const { root, sourceFile } = await createTypeScriptFixtureProject(
      "aiq-engine-ts-missing-runner-",
    );
    vi.spyOn(ToolRunner.prototype, "runNodeTool").mockResolvedValueOnce(
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
      stages: ["typecheck"],
      writeArtifacts: false,
    });

    const diagnostic = result.stages[0]?.diagnostics[0];

    expect(result.ok).toBe(false);
    expect(result.stages[0]).toMatchObject({
      stageId: "typecheck",
      status: "failed",
    });
    expect(diagnostic).toMatchObject({
      source: "tsc",
      message: expect.stringContaining("Run aiq setup"),
    });
    expect(diagnostic?.message).not.toContain("spawn");
  });
});
