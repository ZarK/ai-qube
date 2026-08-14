import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  acquireInstallLock,
  cleanupGeneratedInstallArtifacts,
  parseLocalInstallArgs,
  resolveInsideRoot,
  runLocalQubeInstall,
} from "../scripts/local-install-qube.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installerPath = path.join(repoRoot, "scripts", "local-install-qube.mjs");

describe("source-checkout QUBE install", () => {
  it("parses prefix and json flags", () => {
    assert.deepEqual(parseLocalInstallArgs(["--json", "--prefix", "/tmp/prefix", "--skip-build"]), {
      json: true,
      help: false,
      skipBuild: true,
      prefix: "/tmp/prefix",
      repoRoot: undefined,
    });
  });

  it("rejects a source path that escapes the repository root", () => {
    assert.throws(() => resolveInsideRoot(repoRoot, "../outside", "repo-root"), { reasonCode: "path-escape" });
    assert.throws(() => resolveInsideRoot(repoRoot, path.resolve(os.tmpdir(), "outside"), "repo-root"), {
      reasonCode: "path-escape",
    });
  });

  it("installs a fixture checkout without packing and keeps git clean", async () => {
    const fixture = await createFixture();
    try {
      const prefix = path.join(fixture.root, "prefix");
      const first = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix,
        skipBuild: true,
        lockDir: fixture.lockDir,
      });
      assert.equal(first.ok, true, first.error);
      assert.deepEqual(first.linked, ["qube", "aib", "aie", "aiu", "aiq"]);
      assert.equal(path.basename(first.coreModule), "qube-core");
      assert.equal(first.components.ok, true);
      assert.match(readTrackedStatus(fixture.root), /^$/);
      assert.equal(existsTarball(fixture.root), false);

      const second = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix,
        skipBuild: true,
        lockDir: fixture.lockDir,
      });
      assert.equal(second.ok, true, second.error);
      assert.match(readTrackedStatus(fixture.root), /^$/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("runs the production script against a fixture through a fresh prefix", async () => {
    const fixture = await createFixture();
    try {
      const prefix = path.join(fixture.root, "prefix");
      const result = execFileSync(process.execPath, [
        installerPath,
        "--json",
        "--skip-build",
        "--repo-root",
        fixture.root,
        "--prefix",
        prefix,
      ], {
        encoding: "utf8",
        env: { ...process.env, QUBE_LOCAL_INSTALL_PREFIX: prefix },
      });
      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, true, parsed.error);
      assert.ok(parsed.linked.includes("aiq"));
    } finally {
      await fixture.cleanup();
    }
  });

  it("restores rewritten manifests and deletes generated tarballs after an injected build failure", async () => {
    const fixture = await createFixture();
    try {
      writeFileSync(path.join(fixture.qubeDir, "tjalve-qube-9.9.9.tgz"), "leftover\n");
      const original = readFileUtf8(path.join(fixture.qubeDir, "package.json"));
      const result = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix: path.join(fixture.root, "prefix"),
        skipBuild: true,
        lockDir: fixture.lockDir,
        injectFailure: "build",
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "build-failed");
      assert.equal(readFileUtf8(path.join(fixture.qubeDir, "package.json")), original);
      assert.equal(existsTarball(fixture.root), false);
      assert.match(readTrackedStatus(fixture.root), /^$/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("restores and removes pack leftovers after an injected pack failure", async () => {
    const fixture = await createFixture();
    try {
      const original = readFileUtf8(path.join(fixture.qubeDir, "package.json"));
      const result = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix: path.join(fixture.root, "prefix"),
        skipBuild: true,
        lockDir: fixture.lockDir,
        injectFailure: "pack",
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "pack-failed");
      assert.equal(readFileUtf8(path.join(fixture.qubeDir, "package.json")), original);
      assert.equal(existsTarball(fixture.root), false);
      assert.match(readTrackedStatus(fixture.root), /^$/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails immediately when a selected component executable is missing", async () => {
    const fixture = await createFixture();
    try {
      rmSync(path.join(fixture.root, "products", "aiq", "packages", "cli", "dist", "bin", "aiq.js"));
      const result = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix: path.join(fixture.root, "prefix"),
        skipBuild: true,
        lockDir: fixture.lockDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "missing-component");
      assert.match(result.error, /aiq/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a symlink package directory that escapes the checkout", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "qube-local-install-outside-"));
    try {
      rmSync(fixture.qubeDir, { recursive: true, force: true });
      symlinkSync(outside, fixture.qubeDir, process.platform === "win32" ? "junction" : "dir");
      const result = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix: path.join(fixture.root, "prefix"),
        skipBuild: true,
        lockDir: fixture.lockDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "path-escape");
    } finally {
      await rm(outside, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it("rejects a second process while the first holds the lock", async () => {
    const fixture = await createFixture();
    const lock = acquireInstallLock(fixture.root, fixture.lockDir);
    try {
      const result = await runLocalQubeInstall({
        repoRoot: fixture.root,
        prefix: path.join(fixture.root, "prefix"),
        skipBuild: true,
        lockDir: fixture.lockDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "lock-held");
    } finally {
      lock.release();
      await fixture.cleanup();
    }
  });

  it("cleanup does not follow a tarball symlink out of the checkout", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qube-local-install-symlink-clean-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "qube-local-install-symlink-target-"));
    try {
      const qubeDir = path.join(root, "products", "qube");
      mkdirSync(qubeDir, { recursive: true });
      const outsideFile = path.join(outside, "secret.tgz");
      writeFileSync(outsideFile, "keep\n");
      symlinkSync(outsideFile, path.join(qubeDir, "tjalve-escape.tgz"), process.platform === "win32" ? "file" : undefined);
      cleanupGeneratedInstallArtifacts(root);
      assert.equal(readFileUtf8(outsideFile), "keep\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function readFileUtf8(filePath) {
  return readFileSync(filePath, "utf8");
}

function existsTarball(root) {
  const dir = path.join(root, "products", "qube");
  return existsSync(dir) && readdirSync(dir).some(name => /^tjalve-.*\.tgz$/i.test(name));
}

function readTrackedStatus(root) {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qube-local-install-fixture-"));
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "qube-local-install-locks-"));
  const qubeDir = path.join(root, "products", "qube");
  const coreDir = path.join(root, "packages", "qube-core");
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    private: true,
    scripts: { "install:qube:local": "node scripts/local-install-qube.mjs" },
  }, null, 2)}\n`);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts", "restore-publish-dependencies.mjs"),
    readFileSync(path.join(repoRoot, "scripts", "restore-publish-dependencies.mjs"), "utf8")
  );
  writePackage(qubeDir, "@tjalve/qube", "0.0.0", "bin/run", componentsBinSource());
  writePackage(path.join(root, "products", "aib"), "@tjalve/aib", "0.0.0", "bin/run", "process.stdout.write('aib\\n');\n");
  writePackage(path.join(root, "products", "aie"), "@tjalve/aie", "0.0.0", "bin/run", "process.stdout.write('aie\\n');\n");
  writePackage(path.join(root, "products", "aiu"), "@tjalve/aiu", "0.0.0", "dist/src/bin/aiu.js", "process.stdout.write('aiu\\n');\n");
  writePackage(path.join(root, "products", "aiq", "packages", "cli"), "@tjalve/aiq", "0.0.0", "dist/bin/aiq.js", "process.stdout.write('aiq\\n');\n");
  writePackage(coreDir, "@tjalve/qube-core", "0.0.0", null, null);
  const linkedCore = path.join(qubeDir, "node_modules", "@tjalve", "qube-core");
  mkdirSync(path.dirname(linkedCore), { recursive: true });
  symlinkSync(coreDir, linkedCore, process.platform === "win32" ? "junction" : "dir");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Qube Test", "-c", "user.email=qube@example.test", "commit", "-m", "fixture"], {
    cwd: root,
    stdio: "ignore",
  });
  return {
    root,
    qubeDir,
    lockDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(lockDir, { recursive: true, force: true });
    },
  };
}

function writePackage(dir, name, version, binRelative, source) {
  mkdirSync(dir, { recursive: true });
  const manifest = { name, version, private: true, type: "module" };
  if (binRelative) {
    const command = path.posix.basename(binRelative, path.posix.extname(binRelative)) === "run"
      ? name.split("/")[1]
      : path.posix.basename(binRelative, path.posix.extname(binRelative));
    manifest.bin = { [command]: binRelative };
    const binPath = path.join(dir, binRelative);
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(binPath, `#!/usr/bin/env node\n${source}`);
    try {
      chmodSync(binPath, 0o755);
    } catch {
      // Windows filesystems may reject POSIX mode bits.
    }
  }
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function componentsBinSource() {
  return `
const payload = {
  ok: true,
  command: "components",
  components: [{ id: "composer", command: "qube", packageName: "@tjalve/qube", packageVersion: "0.0.0" }]
};
if (process.argv.slice(2).includes("components")) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
  process.exit(0);
}
if (process.argv.slice(2).includes("doctor")) {
  process.stdout.write(JSON.stringify({ ok: true, command: "doctor" }) + "\\n");
  process.exit(0);
}
process.stdout.write("ok\\n");
`;
}
