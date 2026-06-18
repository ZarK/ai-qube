import { describe, expect, it } from "vitest";
import {
  fixtureFile,
  normalizeFileManifest,
  path,
  resolveRunRequest,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("normalizes and de-duplicates manifest paths", async () => {
    const manifest = await normalizeFileManifest(
      {
        files: ["test-projects/typescript/src/index.ts", fixtureFile],
        source: "mixed",
      },
      process.cwd(),
    );

    expect(manifest.entries).toEqual([
      {
        extension: ".ts",
        path: fixtureFile,
      },
    ]);
    expect(manifest.files).toEqual([fixtureFile]);
    expect(manifest.source).toBe("mixed");
    expect(manifest.summary.fileCount).toBe(1);
  });

  it("resolves adapter-agnostic run requests", async () => {
    const request = await resolveRunRequest({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      profile: "fast",
    });

    expect(request.context).toBe("cli");
    expect(request.cwd).toBe(process.cwd());
    expect(request.manifest.root).toBe(process.cwd());
    expect(request.manifest.summary.fileCount).toBe(1);
    expect(request.outDir).toBe(path.resolve(process.cwd(), ".aiq/out"));
    expect(request.selection).toEqual({
      stages: ["lint"],
      profile: "fast",
    });
  });
});
