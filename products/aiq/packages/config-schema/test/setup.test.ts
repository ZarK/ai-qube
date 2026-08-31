import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type TestContext, afterEach, describe, expect, it } from "vitest";

import {
  aiqStageLadderIds,
  applyAiqSetupPlan,
  loadAiqProgress,
  planAiqSetup,
  resolveAiqProgressStageIds,
  setAiqProgressStage,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("AIQ setup contract", () => {
  it("plans without writes, applies once, and reports an exact no-op repeat", async () => {
    const repoDir = await createTempRepo("aiq-setup-repeat-");
    const dryRun = await planAiqSetup({ cwd: repoDir, dryRun: true, stages: ["typecheck"] });

    expect(dryRun.config.operation).toBe("skip");
    expect(dryRun.progress.operation).toBe("create");
    await applyAiqSetupPlan(dryRun);
    await expect(access(dryRun.config.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(dryRun.progress.path)).rejects.toMatchObject({ code: "ENOENT" });

    const first = await applyAiqSetupPlan(
      await planAiqSetup({ cwd: repoDir, stages: ["typecheck"] }),
    );
    const firstProgress = await readFile(first.progress.path, "utf8");
    const second = await applyAiqSetupPlan(
      await planAiqSetup({ cwd: repoDir, stages: ["typecheck"] }),
    );

    expect(first.config.operation).toBe("skip");
    expect(first.progress.operation).toBe("create");
    expect(second.config.operation).toBe("skip");
    expect(second.progress.operation).toBe("skip");
    await expect(access(second.config.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(second.progress.path, "utf8")).toBe(firstProgress);
  });

  it("preserves valid custom config exactly", async () => {
    const repoDir = await createTempRepo("aiq-setup-custom-");
    const configPath = path.join(repoDir, ".qube", "aiq", "config.json");
    const customConfig = `${JSON.stringify(
      {
        version: 1,
        profiles: { fast: { changedOnly: false, stages: ["lint", "unit"] } },
      },
      null,
      4,
    )}\n`;
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, customConfig, "utf8");

    const applied = await applyAiqSetupPlan(
      await planAiqSetup({ cwd: repoDir, stages: ["lint", "unit"] }),
    );

    expect(applied.config).toMatchObject({ custom: true, operation: "skip", path: configPath });
    expect(await readFile(configPath, "utf8")).toBe(customConfig);
  });

  it("rejects progress-file symlinks without changing an outside target", async (context) => {
    const workspaceDir = await createTempRepo("aiq-setup-symlink-");
    const repoDir = path.join(workspaceDir, "repo");
    const progressPath = path.join(repoDir, ".qube", "aiq", "progress.json");
    const configPath = path.join(repoDir, ".qube", "aiq", "config.json");
    const outsidePath = path.join(workspaceDir, "outside-progress.json");
    const outsideProgress = `${JSON.stringify({
      current_stage: 0,
      disabled: [],
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      last_run: null,
    })}\n`;
    await mkdir(path.dirname(progressPath), { recursive: true });
    await writeFile(outsidePath, outsideProgress, "utf8");
    const stalePlan = await planAiqSetup({ cwd: repoDir, stages: ["typecheck"] });
    await createTestSymlink(outsidePath, progressPath, "file", context);

    await expect(applyAiqSetupPlan(stalePlan)).rejects.toThrow(/symbolic link/u);
    await expect(planAiqSetup({ cwd: repoDir, stages: ["typecheck"] })).rejects.toThrow(
      /symbolic link/u,
    );
    expect(await readFile(outsidePath, "utf8")).toBe(outsideProgress);
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });

    const danglingRepoDir = path.join(workspaceDir, "dangling-repo");
    const danglingPath = path.join(danglingRepoDir, ".qube", "aiq", "progress.json");
    await mkdir(path.dirname(danglingPath), { recursive: true });
    await createTestSymlink(
      path.join(workspaceDir, "missing-progress.json"),
      danglingPath,
      "file",
      context,
    );
    await expect(planAiqSetup({ cwd: danglingRepoDir })).rejects.toThrow(/symbolic link/u);
  });

  it("rejects a linked setup parent without changing its outside target", async (context) => {
    const workspaceDir = await createTempRepo("aiq-setup-parent-symlink-");
    const linkedParentRepoDir = path.join(workspaceDir, "repo");
    const outsideQubeDir = path.join(workspaceDir, "outside-qube");
    const outsideProgressPath = path.join(outsideQubeDir, "aiq", "progress.json");
    const outsideProgress = `${JSON.stringify({
      current_stage: 0,
      disabled: [],
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      last_run: null,
    })}\n`;
    await mkdir(path.join(outsideQubeDir, "aiq"), { recursive: true });
    await mkdir(linkedParentRepoDir, { recursive: true });
    await writeFile(outsideProgressPath, outsideProgress, "utf8");
    const stalePlan = await planAiqSetup({ cwd: linkedParentRepoDir, stages: ["typecheck"] });
    await createTestSymlink(
      outsideQubeDir,
      path.join(linkedParentRepoDir, ".qube"),
      process.platform === "win32" ? "junction" : "dir",
      context,
    );
    await expect(applyAiqSetupPlan(stalePlan)).rejects.toThrow(/symbolic link/u);
    expect(await readFile(outsideProgressPath, "utf8")).toBe(outsideProgress);
    await expect(access(path.join(outsideQubeDir, "aiq", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects non-files and non-directory setup parents", async () => {
    const workspaceDir = await createTempRepo("aiq-setup-non-file-");
    const directoryRepo = path.join(workspaceDir, "directory-repo");
    const progressPath = path.join(directoryRepo, ".qube", "aiq", "progress.json");
    await mkdir(progressPath, { recursive: true });

    await expect(planAiqSetup({ cwd: directoryRepo })).rejects.toThrow(/non-file AIQ setup path/u);

    const blockedParentRepo = path.join(workspaceDir, "blocked-parent-repo");
    const blockedParent = path.join(blockedParentRepo, ".qube");
    await mkdir(blockedParentRepo, { recursive: true });
    await writeFile(blockedParent, "unchanged\n", "utf8");

    await expect(planAiqSetup({ cwd: blockedParentRepo })).rejects.toThrow(
      /non-directory AIQ setup parent/u,
    );
    expect(await readFile(blockedParent, "utf8")).toBe("unchanged\n");
  });

  it("uses cumulative semantics for one stage, exact semantics for many, and cumulative reset", async () => {
    const repoDir = await createTempRepo("aiq-setup-selection-");
    const single = await planAiqSetup({ cwd: repoDir, stages: ["maintainability"] });
    const multiple = await planAiqSetup({
      cwd: repoDir,
      stages: ["maintainability", "lint"],
    });

    expect(single.selection).toEqual({
      mode: "cumulative",
      requestedStages: ["maintainability"],
      resolvedStages: aiqStageLadderIds.slice(0, 8),
    });
    expect(multiple.selection).toEqual({
      mode: "exact",
      requestedStages: ["lint", "maintainability"],
      resolvedStages: ["lint", "maintainability"],
    });

    await applyAiqSetupPlan(multiple);
    const exactProgress = await loadAiqProgress(repoDir);
    expect(resolveAiqProgressStageIds(exactProgress.progress)).toEqual(["lint", "maintainability"]);
    expect(exactProgress.progress.disabled).toEqual([0, 2, 3, 4, 5, 6]);

    const reset = await setAiqProgressStage(repoDir, 3);
    expect(resolveAiqProgressStageIds(reset.progress)).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
    ]);
    expect(reset.progress.disabled).toEqual([]);
  });
});

async function createTempRepo(prefix: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoDir);
  return repoDir;
}

async function createTestSymlink(
  targetPath: string,
  linkPath: string,
  type: "dir" | "file" | "junction",
  context: TestContext,
): Promise<void> {
  try {
    await symlink(targetPath, linkPath, type);
  } catch (error) {
    if (
      process.platform === "win32" &&
      isNodeError(error) &&
      ["EACCES", "ENOSYS", "ENOTSUP", "EPERM", "UNKNOWN"].includes(error.code ?? "")
    ) {
      context.skip(`Windows symlink creation is unavailable: ${error.code}`);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
