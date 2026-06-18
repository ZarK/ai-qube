import { describe, expect, it } from "vitest";
import {
  adapterPackageWorkspaces,
  internalPackageWorkspaces,
  path,
  readFile,
  repoRoot,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("keeps former split packages private to the workspace", async () => {
    for (const workspace of internalPackageWorkspaces) {
      const packageJson = JSON.parse(
        await readFile(path.join(repoRoot, workspace, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        name: string;
        private?: boolean;
        publishConfig?: unknown;
      };

      expect(packageJson.private).toBe(true);
      expect(packageJson.publishConfig).toBeUndefined();
      expect(packageJson.name.startsWith("@tjalve/aiq-")).toBe(false);

      for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
        expect(dependencyName.startsWith("@tjalve/aiq-")).toBe(false);
      }
    }
  });

  it("keeps adapter packages on the canonical aiq package surface", async () => {
    for (const workspace of adapterPackageWorkspaces) {
      const packageJson = JSON.parse(
        await readFile(path.join(repoRoot, workspace, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; version: string };
      const aiqDependencies = Object.keys(packageJson.dependencies ?? {}).filter((dependency) =>
        dependency.startsWith("@tjalve/aiq"),
      );

      expect(packageJson.dependencies?.["@tjalve/aiq"]).toBe(packageJson.version);
      expect(aiqDependencies).toEqual(["@tjalve/aiq"]);
    }
  });

  it("restores the published quality bin alias", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ) as { bin?: Record<string, string>; exports?: Record<string, unknown> };

    expect(packageJson.bin).toMatchObject({
      aiq: "dist/bin/aiq.js",
      quality: "dist/bin/aiq.js",
    });
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
      ".",
      "./api",
      "./benchmark",
      "./config",
      "./engine",
      "./model",
      "./reporters",
      "./schema",
    ]);
  });
});
