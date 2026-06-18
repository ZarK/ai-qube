import { describe, expect, it } from "vitest";
import {
  lintFailureFixtureFile,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
  writeReportArtifact,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("writes report artifacts to the requested outDir even if the result carries another path", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-"));
    const overrideDir = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-override-"));
    tempDirs.push(outDir, overrideDir);

    const result = await runEngine({
      context: "cli",
      manifest: {
        files: [lintFailureFixtureFile],
        source: "direct",
      },
      mode: "check",
      outDir,
      stages: ["lint"],
      writeArtifacts: false,
    });

    const overridePath = path.join(overrideDir, "override.report.json");
    const writtenPath = await writeReportArtifact(
      {
        ...result,
        artifacts: {
          ...result.artifacts,
          reportPath: overridePath,
        },
      },
      outDir,
    );

    expect(writtenPath).toBe(path.join(outDir, "aiq.report.json"));
    const reportJson = JSON.parse(await readFile(writtenPath, "utf8")) as {
      artifacts: { reportPath: string };
    };
    expect(reportJson.artifacts.reportPath).toBe(writtenPath);
    await expect(readFile(overridePath, "utf8")).rejects.toThrow();
  });
});
