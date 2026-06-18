import { describe, expect, it } from "vitest";
import { AiqEngineCancelledError, fixtureFile, runEngine } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("rejects cancelled runs before task execution starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEngine({
        context: "cli",
        manifest: {
          files: [fixtureFile],
          source: "direct",
        },
        mode: "check",
        stages: ["lint"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);
  });

  it("rejects cancelled runs before request resolution runs", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEngine({
        context: "cli",
        manifest: {
          files: ["missing-before-resolution.ts"],
          source: "direct",
        },
        mode: "check",
        stages: ["lint"],
        signal: controller.signal,
        writeArtifacts: false,
      }),
    ).rejects.toBeInstanceOf(AiqEngineCancelledError);
  });
});
