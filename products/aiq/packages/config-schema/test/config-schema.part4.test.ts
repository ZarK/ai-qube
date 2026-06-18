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
  it("keeps explicit invocation stages even when the repo disables them", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await writeFile(
      path.join(repoDir, "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          stages: {
            security: {
              enabled: false,
            },
          },
          surfaces: {
            cli: {
              profile: "fast",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await resolveAiqConfig({
      cwd: repoDir,
      stages: ["security", "security"],
      surface: "cli",
    });

    expect(resolved.stages).toEqual(["security"]);
  });

  it("fails fast on invalid config shape", () => {
    expect(() =>
      validateAiqConfigFile({
        version: 1,
        profiles: {
          fast: {
            stages: ["lint", "bogus"],
          },
        },
      }),
    ).toThrowError("contains unsupported stage 'bogus'");
  });

  it("fails fast on invalid progress state", () => {
    expect(() => validateAiqProgressState({ current_stage: 10 })).toThrowError(
      "current_stage must be a stage index from 0 to 9",
    );
    expect(() => validateAiqProgressState({ current_stage: 1, disabled: ["lint"] })).toThrowError(
      "disabled[0] must be a stage index from 0 to 9",
    );
    expect(() => validateAiqProgressState({ current_stage: 1, unexpected: true })).toThrowError(
      "contains unsupported key 'unexpected'",
    );
  });

  it("fails fast on unsupported stage languages and tool ids", () => {
    expect(() =>
      validateAiqConfigFile({
        version: 1,
        stages: {
          lint: {
            languages: {
              csharp: {
                enabled: true,
                tool: "dotnet",
              },
            },
          },
        },
      }),
    ).toThrowError("contains unsupported language 'csharp'");

    expect(() =>
      validateAiqConfigFile({
        version: 1,
        stages: {
          lint: {
            languages: {
              javascript: {
                enabled: true,
                tool: "bogus",
              },
            },
          },
        },
      }),
    ).toThrowError("tool must be one of");

    expect(() =>
      validateAiqConfigFile({
        version: 1,
        stages: {
          unit: {
            languages: {
              typescript: {
                enabled: true,
                tool: "typescript",
              },
            },
          },
        },
      }),
    ).toThrowError("unsupported for stage 'unit'");
  });

  it("rejects unknown keys and unsupported versions", () => {
    expect(() => validateAiqConfigFile({ version: 2 })).toThrowError("version must be 1");
    expect(() => validateAiqConfigFile({ version: 1, unexpected: true })).toThrowError(
      "contains unsupported key 'unexpected'",
    );
  });

  it("fails fast on malformed JSON during config load", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(path.join(repoDir, ".aiq", "aiq.config.json"), '{"version":1,}\n');

    await expect(loadAiqConfig(repoDir)).rejects.toThrowError("Failed to parse");
  });

  it("fails fast on malformed JSON during progress load", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-progress-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(path.join(repoDir, ".aiq", "progress.json"), '{"current_stage":1,}\n');

    await expect(loadAiqProgress(repoDir)).rejects.toThrowError("Failed to parse");
  });
});
