import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { detectRepositoryPackageManager, resolveAiuHookCommand } from "../dist/src/hook_command.js";

describe("portable Stop-hook command resolution", () => {
  it("uses the selected repository package manager without a fixed pnpm command", async () => {
    const npmRoot = await mkdtemp(path.join(tmpdir(), "aiu-hook-command-npm-"));
    const pnpmRoot = await mkdtemp(path.join(tmpdir(), "aiu-hook-command-pnpm-"));
    try {
      await writeFile(path.join(npmRoot, "package-lock.json"), "{}\n", "utf8");
      await writeFile(path.join(pnpmRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

      assert.equal(detectRepositoryPackageManager(npmRoot, {}), "npm");
      assert.equal(resolveAiuHookCommand(npmRoot, { PATH: "" }).commandPrefix, "npm exec -- aiu");
      assert.equal(detectRepositoryPackageManager(pnpmRoot, {}), "pnpm");
      assert.equal(resolveAiuHookCommand(pnpmRoot, { PATH: "" }).commandPrefix, "pnpm exec aiu");
    } finally {
      await rm(npmRoot, { recursive: true, force: true });
      await rm(pnpmRoot, { recursive: true, force: true });
    }
  });

  it("prefers a resolved package-local executable over the package manager", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-hook-command-local-"));
    try {
      const binDirectory = path.join(target, "node_modules", ".bin");
      const executable = path.join(binDirectory, process.platform === "win32" ? "aiu.cmd" : "aiu");
      await mkdir(binDirectory, { recursive: true });
      await writeFile(path.join(target, "package-lock.json"), "{}\n", "utf8");
      await writeFile(executable, "", "utf8");

      const resolved = resolveAiuHookCommand(target, { PATH: "" });
      assert.equal(resolved.source, "package-local");
      assert.equal(resolved.packageManager, "npm");
      assert.match(resolved.commandPrefix, /node_modules[\\/]\.bin[\\/]aiu/i);
      assert.equal(resolved.commandPrefix.includes(target), false);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
