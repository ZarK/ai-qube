import { describe, expect, it } from "vitest";
import type { LanguageId } from "./runners-test-support.js";
import {
  buildEngineContext,
  createSingleLanguageStageConfiguration,
  fixtureFile,
  fixtureTsconfig,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  sharedMetricsStages,
  tempDirs,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("no-ops shared metrics for unsupported language file types without placeholders", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-unsupported-metrics-matrix-"));
    tempDirs.push(tempDir);

    const unsupportedFiles = [
      {
        contents: 'resource "null_resource" "example" {}\n',
        languageId: "terraform",
        name: "main.tf",
      },
      { contents: "locals { value = 1 }\n", languageId: "hcl", name: "main.hcl" },
      { contents: "echo hi\n", languageId: "bash", name: "script.sh" },
      { contents: "Write-Host 'hi'\n", languageId: "powershell", name: "script.ps1" },
      { contents: "<main>Hello</main>\n", languageId: "html", name: "index.html" },
      { contents: ".button { color: red; }\n", languageId: "css", name: "style.css" },
      { contents: "name: value\n", languageId: "yaml", name: "config.yaml" },
      { contents: "select 1;\n", languageId: "sql", name: "query.sql" },
      { contents: "# Notes\n", languageId: "documents", name: "notes.md" },
    ] as const satisfies readonly Array<{
      contents: string;
      languageId: LanguageId;
      name: string;
    }>;

    for (const fixture of unsupportedFiles) {
      const file = path.join(tempDir, fixture.name);
      await writeFile(file, fixture.contents, "utf8");

      for (const stageId of sharedMetricsStages) {
        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [file],
            id: `test:1:${stageId}-${fixture.languageId}-unsupported-metrics`,
            stageId,
          },
          await buildEngineContext({
            context: "cli",
            cwd: tempDir,
            manifest: { files: [file], source: "direct" },
            mode: "check",
            stageConfigurations: createSingleLanguageStageConfiguration(
              stageId,
              fixture.languageId,
            ),
            stages: [stageId],
            writeArtifacts: false,
          }),
        );

        expect(JSON.stringify(result)).not.toContain("not_implemented");
        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.toolRuns).toEqual([]);
      }
    }
  });

  it("keeps supported shared metrics runs while reporting mixed unsupported files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-mixed-shared-metrics-"));
    tempDirs.push(tempDir);

    const cssFile = path.join(tempDir, "style.css");
    await writeFile(cssFile, ".button { color: red; }\n", "utf8");

    for (const stageId of sharedMetricsStages) {
      const result = await runPlannedTask(
        {
          fileCount: 2,
          files: [fixtureFile, cssFile],
          id: `test:1:${stageId}-mixed-unsupported-metrics`,
          stageId,
        },
        process.cwd(),
      );

      expect(JSON.stringify(result)).not.toContain("not_implemented");
      expect(result.status).toBe("failed");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          file: cssFile,
          severity: "error",
          source: "aiq-shared-metrics",
        }),
      ]);
      expect(result.notes.join(" ")).toContain("Unsupported shared metrics files");
      expect(result.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "lizard" }),
        ]),
      );
    }
  });

  it("keeps shared metrics companion files out of unsupported diagnostics", async () => {
    for (const stageId of sharedMetricsStages) {
      const result = await runPlannedTask(
        {
          fileCount: 2,
          files: [fixtureFile, fixtureTsconfig],
          id: `test:1:${stageId}-companion-metrics`,
          stageId,
        },
        process.cwd(),
      );

      expect(JSON.stringify(result)).not.toContain("not_implemented");
      expect(result.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: fixtureTsconfig,
            source: "aiq-shared-metrics",
          }),
        ]),
      );
      expect(result.notes.join(" ")).not.toContain("Unsupported shared metrics files");
      expect(result.toolRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exitCode: 0, status: "passed", tool: "lizard" }),
        ]),
      );
    }
  });
});
