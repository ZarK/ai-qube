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
  it("resolves repo config, profile defaults, surface overrides, and stage filtering", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await mkdir(path.join(repoDir, "packages", "app"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          inputs: {
            ignore: ["dist/**"],
          },
          stages: {
            coverage: {
              enabled: false,
            },
          },
          profiles: {
            standard: {
              changedOnly: false,
              stages: ["lint", "unit", "coverage"],
            },
          },
          surfaces: {
            cli: {
              changedOnly: true,
              stages: ["unit", "coverage"],
              profile: "standard",
              publishDiagnostics: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await resolveAiqConfig({
      cwd: path.join(repoDir, "packages", "app"),
      surface: "cli",
    });

    expect(resolved.source).toBe("file");
    expect(resolved.profile).toBe("standard");
    expect(resolved.changedOnly).toBe(true);
    expect(resolved.publishDiagnostics).toBe(true);
    expect(resolved.stages).toEqual(["unit"]);
    expect(resolved.config.inputs.ignore).toEqual(["dist/**"]);
  });

  it("lets invocation overrides win over surface and profile defaults", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await writeFile(
      path.join(repoDir, "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            deep: {
              changedOnly: true,
              stages: ["lint", "security"],
            },
          },
          surfaces: {
            cli: {
              profile: "standard",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await resolveAiqConfig({
      cwd: repoDir,
      stages: ["security"],
      profile: "deep",
      surface: "cli",
    });

    expect(resolved.profile).toBe("deep");
    expect(resolved.changedOnly).toBe(true);
    expect(resolved.stages).toEqual(["security"]);
  });
});
