import { describe, expect, it } from "vitest";
import {
  createKotlinGradleFixtureProject,
  fixtureTypeScriptRoot,
  hasGradleToolchain,
  mkdir,
  mkdtemp,
  os,
  path,
  runEngine,
  tempDirs,
  writeFile,
} from "./engine-test-support.js";
import { resolveSelectedJavaScriptProjects } from "../src/languages/javascript-projects.js";
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

  it("deduplicates workspace packages that resolve to the same JavaScript test runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-js-workspace-unit-"));
    tempDirs.push(root);

    const packageARoot = path.join(root, "packages", "a");
    const packageBRoot = path.join(root, "packages", "b");
    await Promise.all([
      mkdir(packageARoot, { recursive: true }),
      mkdir(packageBRoot, { recursive: true }),
    ]);
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          scripts: { test: "vitest run" },
          devDependencies: { vitest: "3.2.4" },
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
    );
    await Promise.all([
      writeFile(path.join(packageARoot, "package.json"), '{"name":"a"}\n'),
      writeFile(path.join(packageARoot, "index.ts"), "export const a = 1;\n"),
      writeFile(path.join(packageBRoot, "package.json"), '{"name":"b"}\n'),
      writeFile(path.join(packageBRoot, "index.ts"), "export const b = 2;\n"),
    ]);

    const resolved = await resolveSelectedJavaScriptProjects({
      projects: [
        {
          files: [path.join(packageARoot, "index.ts")],
          packageJsonPath: path.join(packageARoot, "package.json"),
          projectRoot: packageARoot,
        },
        {
          files: [path.join(packageBRoot, "index.ts")],
          packageJsonPath: path.join(packageBRoot, "package.json"),
          projectRoot: packageBRoot,
        },
      ],
      unsupportedFiles: [],
    });

    expect(resolved.unsupportedProjects).toEqual([]);
    expect(resolved.projects).toEqual([
      expect.objectContaining({
        files: [path.join(packageARoot, "index.ts"), path.join(packageBRoot, "index.ts")],
        projectRoot: root,
        runner: "vitest",
      }),
    ]);
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
