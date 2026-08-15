import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readVersion(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")).version;
}

function resolveTag(tag) {
  return spawnSync(process.execPath, ["scripts/resolve-publish-tag.mjs", tag], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

describe("publish tag resolution", () => {
  it("maps package-specific publish tags to a package path and verification command", () => {
    const version = readVersion("products/qube/package.json");
    const result = resolveTag(`publish-qube-v${version}`);
    assert.equal(result.status, 0);

    const plan = JSON.parse(result.stdout);
    assert.deepEqual({
      packageKey: plan.packageKey,
      packageName: plan.packageName,
      version: plan.version,
      filter: plan.filter,
      path: plan.path
    }, {
      packageKey: "qube",
      packageName: "@tjalve/qube",
      version,
      filter: "@tjalve/qube",
      path: "products/qube"
    });
    assert.equal(plan.mode, "package");
    assert.equal(plan.packages.length, 1);
    assert.match(plan.prepare, /@tjalve\/qube-cli/);
    assert.match(plan.verify, /@tjalve\/qube/);
  });

  it("rejects unknown or mismatched package tags before publishing", () => {
    const unknown = resolveTag("publish-missing-v1.2.3-rc.1+build.7");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown package key/);

    const mismatch = resolveTag("publish-qube-v9.9.9");
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match/);
  });

  it("uses the AIQ publish-readiness gate without the full AIQ suite", () => {
    const result = resolveTag(`publish-aiq-v${readVersion("products/aiq/packages/cli/package.json")}`);
    assert.equal(result.status, 0);

    const plan = JSON.parse(result.stdout);
    assert.match(plan.prepare, /@tjalve\/qube-cli/);
    assert.match(plan.prepare, /@tjalve\/aie/);
    assert.match(plan.prepare, /@tjalve\/aiu/);
    assert.match(plan.verify, /@tjalve\/aiq-workspace run build/);
    assert.match(plan.verify, /@tjalve\/aiq-workspace run test:publish-readiness/);
    assert.doesNotMatch(plan.verify, /@tjalve\/aiq-workspace test(?:\s|$)/);
  });

  it("maps the Claude Code adapter publish tag to the adapter package", () => {
    const version = readVersion("adapters/claude-code/package.json");
    const result = resolveTag(`publish-qube-adapter-claude-code-v${version}`);
    assert.equal(result.status, 0);

    const plan = JSON.parse(result.stdout);
    assert.deepEqual({
      packageKey: plan.packageKey,
      packageName: plan.packageName,
      version: plan.version,
      filter: plan.filter,
      path: plan.path
    }, {
      packageKey: "qube-adapter-claude-code",
      packageName: "@tjalve/qube-adapter-claude-code",
      version,
      filter: "@tjalve/qube-adapter-claude-code",
      path: "adapters/claude-code"
    });
    assert.match(plan.prepare, /@tjalve\/qube-core/);
    assert.match(plan.verify, /@tjalve\/qube-adapter-claude-code/);
  });

  it("maps the qube-core first publish tag to the shared core package", () => {
    const version = readVersion("packages/qube-core/package.json");
    const result = resolveTag(`publish-qube-core-v${version}`);
    assert.equal(result.status, 0);

    const plan = JSON.parse(result.stdout);
    assert.deepEqual({
      packageKey: plan.packageKey,
      packageName: plan.packageName,
      version: plan.version,
      filter: plan.filter,
      path: plan.path
    }, {
      packageKey: "qube-core",
      packageName: "@tjalve/qube-core",
      version,
      filter: "@tjalve/qube-core",
      path: "packages/qube-core"
    });
    assert.match(plan.prepare, /@tjalve\/qube-core/);
    assert.match(plan.verify, /@tjalve\/qube-core/);
  });

  it("maps a set tag to every current package and the composer version", () => {
    const version = readVersion("products/qube/package.json");
    const result = resolveTag(`publish-set-v${version}`);
    assert.equal(result.status, 0, result.stderr);

    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, "set");
    assert.equal(plan.setVersion, version);
    assert.equal(plan.packages.length, 15);
    assert.equal(plan.packages[0].packageKey, "qube-core");
    assert.equal(plan.packages.at(-1).packageKey, "qube");
    assert.equal(plan.prepare, "pnpm run build");
    assert.match(plan.verify, /version:audit/);
    assert.equal(plan.packages.some(entry => entry.command === "aie"), true);
  });

  it("rejects a set tag that does not match the composer version", () => {
    const result = resolveTag("publish-set-v0.0.0");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match/);
  });
});
