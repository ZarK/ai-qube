import { describe, expect, it } from "vitest";
import { fixtureFile, resolveRunRequest } from "./engine-test-support.js";
describe("engine foundation", () => {
  it("defaults unresolved run requests to the serve context", async () => {
    const request = await resolveRunRequest({
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
    });

    expect(request.context).toBe("serve");
  });

  it("preserves stage configurations on resolved run requests", async () => {
    const request = await resolveRunRequest({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
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
      profile: "fast",
    });

    expect(request.selection.stageConfigurations).toEqual({
      lint: {
        languages: {
          typescript: {
            toolId: "biome",
          },
        },
      },
    });
  });
});
