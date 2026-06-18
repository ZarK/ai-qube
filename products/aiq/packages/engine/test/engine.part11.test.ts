import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  os,
  path,
  readFile,
  runEngine,
  tempDirs,
  writeFile,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("converts unsupported JavaScript runner placeholders into failed release artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-js-unsupported-release-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ name: "unsupported-release", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "utf8",
    );
    const sourceFile = path.join(tempDir, "src", "index.ts");
    await writeFile(sourceFile, "export const value = 1;\n", "utf8");

    const result = await runEngine({
      context: "cli",
      cwd: tempDir,
      manifest: {
        files: [sourceFile],
        source: "direct",
      },
      mode: "check",
      outDir: tempDir,
      stages: ["unit"],
    });

    expect(result.ok).toBe(false);
    expect(result.summary.status).toBe("failed");
    expect(result.summary.notImplementedStageCount).toBe(0);
    expect(result.stages[0]).toMatchObject({
      diagnostics: [expect.objectContaining({ source: "aiq-js-test-runner" })],
      stageId: "unit",
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("not_implemented");
    expect(JSON.stringify(result)).not.toContain("rewrite foundation slice");

    const reportPath = result.artifacts.reportPath;
    if (reportPath === undefined) {
      throw new Error("Expected report artifact to be written.");
    }

    const reportJson = await readFile(reportPath, "utf8");
    expect(reportJson).not.toContain("not_implemented");
    expect(reportJson).not.toContain("rewrite foundation slice");
  });
});
