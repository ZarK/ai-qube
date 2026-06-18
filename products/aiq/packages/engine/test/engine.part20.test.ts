import { describe, expect, it, vi } from "vitest";
import {
  AiqEngineCancelledError,
  ToolRunner,
  createAbortError,
  createTypeScriptFixtureProject,
  createTypeScriptWorkloadModule,
  mkdir,
  path,
  runEngine,
  writeFile,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("propagates cancellation during extracted TypeScript typecheck", async () => {
    const { root, sourceFile } = await createTypeScriptFixtureProject("aiq-engine-ts-cancel-");
    const generatedDir = path.join(root, "src", "generated");
    await mkdir(generatedDir, { recursive: true });

    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        writeFile(
          path.join(generatedDir, `generated-${index}.ts`),
          createTypeScriptWorkloadModule(index),
          "utf8",
        ),
      ),
    );

    const controller = new AbortController();
    const runNodeToolSpy = vi
      .spyOn(ToolRunner.prototype, "runNodeTool")
      .mockImplementationOnce(async () => {
        controller.abort();
        throw createAbortError();
      });

    await expect(
      runEngine({
        context: "cli",
        cwd: root,
        manifest: {
          files: [sourceFile],
          source: "direct",
        },
        mode: "check",
        stages: ["typecheck"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);

    expect(runNodeToolSpy).toHaveBeenCalledOnce();
  }, 120_000);
});
