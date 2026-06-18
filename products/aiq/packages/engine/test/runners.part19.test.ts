import { describe, expect, it } from "vitest";
import {
  buildEngineContext,
  createSingleLanguageStageConfiguration,
  languageIds,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  sharedMetricsStages,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("invalidates cached JavaScript and TypeScript metrics when lizard config changes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-ts-lizard-config-refresh-"));
    tempDirs.push(tempDir);

    const sourceFile = path.join(tempDir, "index.ts");
    await writeFile(path.join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const firstComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:complexity-js-ts-lizard-config:first",
        stageId: "complexity",
      },
      process.cwd(),
    );

    await writeFile(path.join(tempDir, ".lizard"), "", "utf8");

    const secondComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [sourceFile],
        id: "test:1:complexity-js-ts-lizard-config:second",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(firstComplexity.status).toBe("passed");
    expect(firstComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
    expect(secondComplexity.status).toBe("passed");
    expect(secondComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
  });

  it("keeps configured shared metrics language matrix release-safe", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-shared-metrics-language-matrix-"));
    tempDirs.push(tempDir);

    const neutralFile = path.join(tempDir, "README.txt");
    await writeFile(neutralFile, "plain text\n", "utf8");

    for (const languageId of languageIds) {
      for (const stageId of sharedMetricsStages) {
        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [neutralFile],
            id: `test:1:${stageId}-${languageId}-configured-metrics`,
            stageId,
          },
          await buildEngineContext({
            context: "cli",
            cwd: tempDir,
            manifest: { files: [neutralFile], source: "direct" },
            mode: "check",
            stageConfigurations: createSingleLanguageStageConfiguration(stageId, languageId),
            stages: [stageId],
            writeArtifacts: false,
          }),
        );

        expect(JSON.stringify(result)).not.toContain("not_implemented");
        expect(result.status).toBe("passed");
        expect(result.toolRuns).toEqual([]);
      }
    }
  });
});
