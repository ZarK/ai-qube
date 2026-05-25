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

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".aiq", "progress.json"),
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
      progressPath: path.join(repoDir, ".aiq", "progress.json"),
      progressSource: "file",
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
  });

  it("fails fast when resolving an unknown progress stage index", () => {
    expect(() => resolveAiqProgressStageIndex("unknown" as never)).toThrowError(
      "Unknown AIQ stage id 'unknown'",
    );
  });

  it("prefers .aiq/aiq.config.json during ancestor discovery", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-config-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await mkdir(path.join(repoDir, "packages", "app"), { recursive: true });
    await writeFile(path.join(repoDir, ".aiq", "aiq.config.json"), '{"version":1}\n');
    await writeFile(path.join(repoDir, "aiq.config.json"), '{"version":1}\n');

    const discovered = await findAiqConfigFile(path.join(repoDir, "packages", "app"));

    expect(discovered).toBe(path.join(repoDir, ".aiq", "aiq.config.json"));
  });

  it("discovers progress state from ancestor .aiq directory", async () => {
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
      configPath: path.join(repoDir, ".aiq", "aiq.config.json"),
      progressCreated: true,
      progressPath: path.join(repoDir, ".aiq", "progress.json"),
    });
    expect(JSON.parse(await readFile(result.configPath, "utf8"))).toEqual({ version: 1 });
    expect(JSON.parse(await readFile(result.progressPath, "utf8"))).toEqual(defaultProgressState);
  });

  it("fails fast when initializing with existing malformed config", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "aiq-init-invalid-config-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, ".aiq"), { recursive: true });
    await writeFile(path.join(repoDir, ".aiq", "aiq.config.json"), '{"version":1,}\n');

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
