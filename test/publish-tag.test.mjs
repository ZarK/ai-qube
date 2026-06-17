import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function resolveTag(tag) {
  return spawnSync(process.execPath, ["scripts/resolve-publish-tag.mjs", tag], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
}

describe("publish tag resolution", () => {
  it("maps package-specific publish tags to a package path and verification command", () => {
    const result = resolveTag("publish-qube-v0.1.0");
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
      version: "0.1.0",
      filter: "@tjalve/qube",
      path: "products/qube"
    });
    assert.match(plan.verify, /@tjalve\/qube/);
  });

  it("rejects unknown or mismatched package tags before publishing", () => {
    const unknown = resolveTag("publish-missing-v1.0.0");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown package key/);

    const mismatch = resolveTag("publish-qube-v9.9.9");
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match/);
  });
});
