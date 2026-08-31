import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyAiqSetupPlan, planAiqSetup, resolveAiqConfig } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("layered AIQ config", () => {
  it("resolves user-global, repository, and machine-local leaves independently", async () => {
    const { repoRoot, userHome } = await createFixture();
    await writeJson(path.join(userHome, ".qube", "aiq", "config.json"), {
      version: 1,
      profiles: { fast: { changedOnly: false } },
      surfaces: { cli: { publishDiagnostics: true } },
    });
    await writeJson(path.join(repoRoot, ".qube", "aiq", "config.json"), {
      version: 1,
      profiles: { fast: { changedOnly: true } },
    });
    await writeJson(path.join(repoRoot, ".qube", "aiq", "config.local.json"), {
      version: 1,
      surfaces: { cli: { publishDiagnostics: false } },
    });

    const resolved = await resolveAiqConfig({ cwd: repoRoot, homeDirectory: userHome, surface: "cli" });

    expect(resolved.changedOnly).toBe(true);
    expect(resolved.publishDiagnostics).toBe(false);
    expect(resolved.sources?.["profiles.fast.changedOnly"]).toBe("repository");
    expect(resolved.sources?.["surfaces.cli.publishDiagnostics"]).toBe("machine-local");
    expect(resolved.sources?.["inputs.ignore"]).toBe("default");
  });

  it("uses a changed user-global value immediately when no higher layer sets the field", async () => {
    const { repoRoot, userHome } = await createFixture();
    const globalPath = path.join(userHome, ".qube", "aiq", "config.json");
    await writeJson(globalPath, { version: 1, profiles: { fast: { changedOnly: false } } });
    expect((await resolveAiqConfig({ cwd: repoRoot, homeDirectory: userHome, surface: "cli" })).changedOnly).toBe(false);

    await writeJson(globalPath, { version: 1, profiles: { fast: { changedOnly: true } } });
    const changed = await resolveAiqConfig({ cwd: repoRoot, homeDirectory: userHome, surface: "cli" });
    expect(changed.changedOnly).toBe(true);
    expect(changed.sources?.["profiles.fast.changedOnly"]).toBe("user-global");
  });

  it("fails on an invalid user-global layer even when the repository overrides the field", async () => {
    const { repoRoot, userHome } = await createFixture();
    await writeJson(path.join(userHome, ".qube", "aiq", "config.json"), {
      version: 1,
      profiles: { fast: { changedOnly: "invalid" } },
    });
    await writeJson(path.join(repoRoot, ".qube", "aiq", "config.json"), {
      version: 1,
      profiles: { fast: { changedOnly: true } },
    });

    await expect(resolveAiqConfig({ cwd: repoRoot, homeDirectory: userHome, surface: "cli" }))
      .rejects.toThrow(/user-global config.*profiles\.fast\.changedOnly/u);
  });

  it("does not create a repository config when effective config needs no override", async () => {
    const { repoRoot } = await createFixture();
    const plan = await planAiqSetup({ cwd: repoRoot });
    expect(plan.config.operation).toBe("skip");

    await applyAiqSetupPlan(plan);
    await expect(readFile(path.join(repoRoot, ".qube", "aiq", "config.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes repository values that equal explicit user-global values", async () => {
    const { repoRoot, userHome } = await createFixture();
    const sameConfig = { version: 1 as const, profiles: { fast: { changedOnly: false } } };
    await writeJson(path.join(userHome, ".qube", "aiq", "config.json"), sameConfig);
    const repositoryPath = path.join(repoRoot, ".qube", "aiq", "config.json");
    await writeJson(repositoryPath, sameConfig);

    const plan = await planAiqSetup({ cwd: repoRoot, homeDirectory: userHome });
    expect(plan.config.operation).toBe("remove");
    await applyAiqSetupPlan(plan);
    await expect(readFile(repositoryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const changedGlobal = { version: 1 as const, profiles: { fast: { changedOnly: true } } };
    await writeJson(path.join(userHome, ".qube", "aiq", "config.json"), changedGlobal);
    expect((await resolveAiqConfig({ cwd: repoRoot, homeDirectory: userHome, surface: "cli" })).changedOnly).toBe(true);
  });
});

async function createFixture(): Promise<{ repoRoot: string; userHome: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "aiq-layered-repo-"));
  const userHome = await mkdtemp(path.join(tmpdir(), "aiq-layered-home-"));
  tempRoots.push(repoRoot, userHome);
  await mkdir(path.join(repoRoot, ".git"));
  return { repoRoot, userHome };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
