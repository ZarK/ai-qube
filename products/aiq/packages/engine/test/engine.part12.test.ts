import { describe, expect, it } from "vitest";
import {
  fixtureFile,
  fixtureJavaScriptFile,
  mkdtemp,
  os,
  path,
  runEngine,
  tempDirs,
  writeFile,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("keeps configured Biome language selections while including shared JSON inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-biome-configured-"));
    tempDirs.push(tempDir);
    const javaScriptFile = path.join(tempDir, "bad.js");
    const jsoncFile = path.join(tempDir, "config.jsonc");
    await writeFile(javaScriptFile, "var value = 1;\n", "utf8");
    await writeFile(jsoncFile, '{"name":"typescript-fixture"}\n', "utf8");

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [fixtureFile, fixtureJavaScriptFile, javaScriptFile, jsoncFile],
        source: "mixed",
      },
      mode: "check",
      stages: ["lint"],
      stageConfigurations: {
        lint: {
          languages: {
            typescript: {
              toolId: "biome",
            },
          },
        },
      },
      writeArtifacts: false,
    });

    const lintStage = result.stages.find((stage) => stage.stageId === "lint");

    expect(lintStage).toMatchObject({ stageId: "lint" });
    expect(lintStage?.diagnostics.map((diagnostic) => diagnostic.file)).not.toContain(
      javaScriptFile,
    );
    expect(lintStage?.toolRuns[0]?.args).toContain(fixtureFile);
    expect(lintStage?.toolRuns[0]?.args).toContain(jsoncFile);
    expect(lintStage?.toolRuns[0]?.args).not.toContain(fixtureJavaScriptFile);
    expect(lintStage?.toolRuns[0]?.args).not.toContain(javaScriptFile);
  });
});
