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
  it("reuses the canonical model ids for stages, languages, and surfaces", () => {
    expect(aiqStageIds).toBe(stageIds);
    expect(aiqLanguageIds).toBe(languageIds);
    expect(aiqSurfaceIds).toBe(surfaceIds);
  });

  it("maps progress current_stage to the canonical cumulative stage ladder", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-progress-ladder-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".qube", "aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".qube", "aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
    );

    const loaded = await loadAiqProgress(repoDir);
    const stages = resolveAiqProgressStageIds(loaded.progress.current_stage);
    const workflow = createAiqProgressRunSelection(loaded, stages);

    expect(aiqStageLadderIds).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
      "security",
    ]);
    expect(stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(workflow).toMatchObject({
      currentStage: { id: "typecheck", index: 3, name: "typecheck" },
      defaultRun: {
        range: "0..3",
        stages: [
          { id: "e2e", index: 0 },
          { id: "lint", index: 1 },
          { id: "format", index: 2 },
          { id: "typecheck", index: 3 },
        ],
      },
      progressPath: path.join(repoDir, ".qube", "aiq", "progress.json"),
      progressSource: "file",
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
  });

  it("fails fast when resolving an unknown progress stage index", () => {
    expect(() => resolveAiqProgressStageIndex("unknown" as never)).toThrowError(
      "Unknown AIQ stage id 'unknown'",
    );
  });

  it("prefers .qube/aiq/config.json during ancestor discovery", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".qube", "aiq"), { recursive: true });
    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await mkdir(path.join(repoDir, "packages", "app"), { recursive: true });
    await writeFile(path.join(repoDir, ".qube", "aiq", "config.json"), '{"version":1}\n');
    await writeFile(path.join(repoDir, ".aiq", "aiq.config.json"), '{"version":1}\n');
    await writeFile(path.join(repoDir, "aiq.config.json"), '{"version":1}\n');

    const discovered = await findAiqConfigFile(path.join(repoDir, "packages", "app"));

    expect(discovered).toBe(path.join(repoDir, ".qube", "aiq", "config.json"));
  });

  it("discovers legacy progress state from ancestor .aiq directory", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-progress-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await mkdir(path.join(repoDir, "packages", "app"), { recursive: true });
    await writeFile(path.join(repoDir, ".aiq", "progress.json"), '{"current_stage":3}\n');

    const discovered = await findAiqProgressFile(path.join(repoDir, "packages", "app"));

    expect(discovered).toBe(path.join(repoDir, ".aiq", "progress.json"));
  });

  it("initializes canonical config and progress state", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-init-"));
    tempDirs.push(repoDir);

    const result = await initializeAiqProjectConfig(repoDir);

    expect(result).toEqual({
      configCreated: true,
      configPath: path.join(repoDir, ".qube", "aiq", "config.json"),
      progressCreated: true,
      progressPath: path.join(repoDir, ".qube", "aiq", "progress.json"),
    });
    expect(JSON.parse(await readFile(result.configPath, "utf8"))).toEqual({ version: 1 });
    expect(JSON.parse(await readFile(result.progressPath, "utf8"))).toEqual(defaultProgressState);
  });

  it("fails fast when initializing with existing malformed config", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-init-invalid-config-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".qube", "aiq"), { recursive: true });
    await writeFile(path.join(repoDir, ".qube", "aiq", "config.json"), '{"version":1,}\n');

    await expect(initializeAiqProjectConfig(repoDir)).rejects.toThrowError("Failed to parse");
  });

  it("loads defaults and persists validated progress stage", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-progress-"));
    tempDirs.push(repoDir);

    const defaults = await loadAiqProgress(repoDir);
    expect(defaults.source).toBe("defaults");
    expect(defaults.progress).toEqual(defaultProgressState);

    const saved = await setAiqProgressStage(repoDir, 6);
    expect(saved.source).toBe("file");
    expect(saved.progress.current_stage).toBe(6);

    const reloaded = await loadAiqProgress(repoDir);
    expect(reloaded.source).toBe("file");
    expect(reloaded.progress.current_stage).toBe(6);
  });
});
