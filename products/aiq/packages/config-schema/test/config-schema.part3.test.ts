import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { languageIds, stageIds, surfaceIds } from "../../model/src/index.js";
import {
  aiqLanguageIds,
  aiqStageIds,
  aiqStageLadderIds,
  aiqSurfaceIds,
  createAiqProgressRunSelection,
  defaultProgressState,
  findAiqConfigFile,
  findAiqProgressFile,
  initializeAiqProjectConfig,
  loadAiqConfig,
  loadAiqProgress,
  resolveAiqConfig,
  resolveAiqProgressStageIds,
  resolveAiqProgressStageIndex,
  setAiqProgressStage,
  validateAiqConfigFile,
  validateAiqProgressState,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("config schema", () => {
  it("resolves modular stage language tool selections for requested stages", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await writeFile(
      path.join(repoDir, "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          stages: {
            lint: {
              languages: {
                javascript: {
                  enabled: false,
                  tool: "biome",
                },
                python: {
                  enabled: true,
                  tool: "python",
                },
              },
            },
            unit: {
              languages: {
                javascript: {
                  enabled: false,
                  tool: "javascript",
                },
                typescript: {
                  enabled: true,
                  tool: "javascript",
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await resolveAiqConfig({
      cwd: repoDir,
      stages: ["lint", "unit"],
      surface: "cli",
    });

    const stageConfigurations = resolved.stageConfigurations;
    expect(stageConfigurations).toBeDefined();
    expect(stageConfigurations?.lint?.languages.javascript).toBeUndefined();
    expect(stageConfigurations?.lint?.languages.python).toEqual({ toolId: "python" });
    expect(stageConfigurations?.unit?.languages.javascript).toBeUndefined();
    expect(stageConfigurations?.unit?.languages.typescript).toEqual({
      toolId: "javascript",
    });
    expect(resolved.config.stages.lint.languages.javascript).toEqual({
      enabled: false,
      tool: "biome",
    });
  });

  it("omits stage configurations when using defaults without a repo config", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-defaults-"));
    tempDirs.push(repoDir);

    const resolved = await resolveAiqConfig({
      cwd: repoDir,
      stages: ["lint", "unit"],
      surface: "cli",
    });

    expect(resolved.source).toBe("defaults");
    expect(resolved.stageConfigurations).toBeUndefined();
  });

  it("supports watch cadence and serve surface overrides", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await writeFile(
      path.join(repoDir, "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          surfaces: {
            watch: {
              cadenceMs: 25,
              cadenceStages: ["typecheck"],
              profile: "deep",
            },
            serve: {
              profile: "fast",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const watchResolved = await resolveAiqConfig({
      cwd: repoDir,
      surface: "watch",
    });
    const serveResolved = await resolveAiqConfig({
      cwd: repoDir,
      surface: "serve",
    });

    expect(watchResolved.profile).toBe("deep");
    expect(watchResolved.stages).toEqual(["lint", "typecheck", "unit", "coverage", "security"]);
    expect(watchResolved.cadenceMs).toBe(25);
    expect(watchResolved.cadenceStages).toEqual(["typecheck"]);
    expect(serveResolved.profile).toBe("fast");
    expect(serveResolved.stages).toEqual(["lint"]);
  });
});
