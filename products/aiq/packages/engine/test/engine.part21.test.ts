import { describe, expect, it, vi } from "vitest";
import {
  AiqEngineCancelledError,
  ToolRunner,
  createAbortError,
  createJavaScriptFixtureProject,
  runEngine,
  writeFile,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("propagates cancellation during extracted JavaScript unit runs", async () => {
    const { root, sourceFile, testFile } = await createJavaScriptFixtureProject(
      "aiq-engine-js-unit-cancel-",
    );
    await writeFile(
      testFile,
      [
        'const { greet } = require("./index.js");',
        "",
        'describe("greet", () => {',
        '  test("waits for cancellation", async () => {',
        "    await new Promise((resolve) => setTimeout(resolve, 10_000));",
        '    expect(greet("Alice")).toBe("Hello, Alice!");',
        "  });",
        "});",
        "",
      ].join("\n"),
      "utf8",
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
          files: [sourceFile],
          source: "direct",
        },
        mode: "check",
        stages: ["unit"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);

    expect(runSpy).toHaveBeenCalledOnce();
  }, 120_000);
});
