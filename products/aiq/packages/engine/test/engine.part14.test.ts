import { describe, expect, it } from "vitest";
import {
  createKotlinGradleFixtureProject,
  fixtureTypeScriptRoot,
  hasGradleToolchain,
  path,
  runEngine,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("preserves package.json selections for configured TypeScript JavaScript runners", async () => {
    const result = await runEngine({
      context: "cli",
      cwd: fixtureTypeScriptRoot,
      manifest: {
        files: [path.join(fixtureTypeScriptRoot, "package.json")],
        source: "direct",
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
  });

  it.skipIf(!hasGradleToolchain)(
    "preserves JVM settings files for configured Kotlin runners",
    async () => {
      const project = await createKotlinGradleFixtureProject(
        "aiq-engine-kotlin-settings-selection-",
      );

      const result = await runEngine({
        context: "cli",
        cwd: project.root,
        manifest: {
          files: [path.join(project.root, "settings.gradle.kts")],
          source: "direct",
        },
        mode: "check",
        stages: ["unit"],
        stageConfigurations: {
          unit: {
            languages: {
              kotlin: {
                toolId: "jvm",
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
        expect.objectContaining({ exitCode: 0, status: "passed", tool: "gradle-test" }),
      ]);
      expect(unitStage?.notes.join(" ")).toContain("Gradle test ran");
    },
    120_000,
  );
});
