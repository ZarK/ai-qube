import { describe, expect, it, vi } from "vitest";
import {
  AiqEngineCancelledError,
  ToolRunner,
  createAbortError,
  createJavaScriptFixtureProject,
  createLargeJavaScriptModule,
  mkdir,
  path,
  runEngine,
  writeFile,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("propagates cancellation during extracted JavaScript metrics runs", async () => {
    const { root, sourceFile } = await createJavaScriptFixtureProject(
      "aiq-engine-js-metrics-cancel-",
    );
    const generatedDir = path.join(root, "generated");
    await mkdir(generatedDir, { recursive: true });

    const generatedFiles = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const filePath = path.join(generatedDir, `generated-${index}.js`);
        return writeFile(filePath, createLargeJavaScriptModule(index), "utf8").then(() => filePath);
      }),
    );

    const controller = new AbortController();
    const runSpy = vi.spyOn(ToolRunner.prototype, "run").mockImplementationOnce(async () => {
      controller.abort();
      throw createAbortError();
    });

    await expect(
      runEngine({
        context: "cli",
        cwd: root,
        manifest: {
          files: [sourceFile, ...generatedFiles],
          source: "direct",
        },
        mode: "check",
        stages: ["complexity"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);

    expect(runSpy).toHaveBeenCalledOnce();
  }, 120_000);
});
