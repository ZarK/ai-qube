import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const audit = JSON.parse(await readFile(path.join(repoRoot, "docs/release/version-audit.json"), "utf8"));

function runScript(scriptName, packageJsonPath) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts", scriptName), packageJsonPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("publish manifest safety", () => {
  for (const entry of audit.packages ?? []) {
    it(`resolves workspace dependencies for ${entry.name}`, async () => {
      const sourcePath = path.join(repoRoot, entry.packageJson);
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "qube-publish-manifest-"));
      const tempPackageJsonPath = path.join(tempDir, "package.json");

      try {
        await copyFile(sourcePath, tempPackageJsonPath);
        const source = JSON.parse(await readFile(tempPackageJsonPath, "utf8"));
        const hasWorkspaceDependency = ["dependencies", "optionalDependencies", "peerDependencies"].some(field => {
          const values = source[field];
          return values && Object.values(values).some(version => String(version).startsWith("workspace:"));
        });

        if (hasWorkspaceDependency) {
          const unresolved = runScript("check-publish-manifest.mjs", tempPackageJsonPath);
          assert.notEqual(unresolved.status, 0, "workspace protocol must fail publish manifest check before resolution");
        }

        const resolved = runScript("resolve-publish-dependencies.mjs", tempPackageJsonPath);
        assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);

        const checked = runScript("check-publish-manifest.mjs", tempPackageJsonPath);
        assert.equal(checked.status, 0, checked.stderr || checked.stdout);

        const manifest = JSON.parse(await readFile(tempPackageJsonPath, "utf8"));
        for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
          const values = manifest[field];
          if (!values) continue;
          for (const [name, version] of Object.entries(values)) {
            assert.doesNotMatch(String(version), /^workspace:/, `${entry.name} ${field}.${name} must not publish workspace protocol`);
            assert.match(String(version), /^\d+\.\d+\.\d+/, `${entry.name} ${field}.${name} must publish an exact version`);
          }
        }

        const restored = runScript("restore-publish-dependencies.mjs", tempPackageJsonPath);
        assert.equal(restored.status, 0, restored.stderr || restored.stdout);
        const afterRestore = await readFile(tempPackageJsonPath, "utf8");
        const beforeResolve = await readFile(sourcePath, "utf8");
        assert.equal(afterRestore, beforeResolve);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }
});