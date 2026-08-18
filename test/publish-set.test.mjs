import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { collectVersionAuditFailures } from "../scripts/check-version-audit.mjs";
import {
  finalizePublishPlan,
  readPublishedVersions,
  registryPackageUrl,
  resolvePublishTag,
} from "../scripts/publish-packages.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function packageEntry(packageKey, packageName, version) {
  return { packageKey, packageName, version, path: "products/qube", command: null };
}

describe("publish set finalization", () => {
  it("publishes only unpublished workspace versions and keeps the full set for verify", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const resolved = await resolvePublishTag(`publish-set-v${version}`, repoRoot);
    const publishedByName = new Map(resolved.packages.map(entry => [
      entry.packageName,
      entry.packageKey === "qube" ? [] : [entry.version],
    ]));

    const plan = finalizePublishPlan(resolved, publishedByName);
    assert.equal(plan.packages.length, 1);
    assert.equal(plan.packages[0].packageKey, "qube");
    assert.equal(plan.verifyPackages.length, resolved.packages.length);
    assert.equal(plan.skipped.length, resolved.packages.length - 1);
    assert.equal(plan.skipped.every(entry => entry.skipReason === "already-published"), true);
    assert.equal(plan.verifyPackages.some(entry => entry.packageKey === "aie"), true);
  });

  it("fails when the set has nothing to publish", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const resolved = await resolvePublishTag(`publish-set-v${version}`, repoRoot);
    const publishedByName = new Map(resolved.packages.map(entry => [entry.packageName, [entry.version]]));

    assert.throws(() => finalizePublishPlan(resolved, publishedByName), {
      reasonCode: "nothing-to-publish",
    });
  });

  it("fails a single-package tag whose version is already on npm", () => {
    const plan = {
      mode: "package",
      packages: [packageEntry("qube", "@tjalve/qube", "0.2.5")],
    };
    assert.throws(
      () => finalizePublishPlan(plan, new Map([["@tjalve/qube", ["0.2.5"]]])),
      { reasonCode: "already-published" }
    );
  });

  it("treats a missing registry package as unpublished and fails closed on registry errors", async () => {
    const missing = await readPublishedVersions("@tjalve/missing-package", {
      fetch: async () => ({ status: 404, ok: false }),
    });
    assert.deepEqual(missing, []);

    await assert.rejects(
      () => readPublishedVersions("@tjalve/qube", {
        fetch: async () => ({ status: 500, ok: false }),
      }),
      { reasonCode: "registry-lookup" }
    );
    assert.equal(
      registryPackageUrl("@tjalve/qube"),
      "https://registry.npmjs.org/@tjalve%2fqube"
    );
  });

  it("allows a selected version that already matches npm latest and rejects one that is behind", () => {
    const manifests = {
      "products/qube/package.json": { name: "@tjalve/qube", version: "0.2.5" },
      "products/aie/package.json": { name: "@tjalve/aie", version: "0.2.3" },
    };
    const equal = collectVersionAuditFailures({
      packages: [{
        name: "@tjalve/qube",
        packageJson: "products/qube/package.json",
        published: true,
        latestPublished: "0.2.5",
        selectedVersion: "0.2.5",
      }],
    }, relativePath => manifests[relativePath]);
    assert.deepEqual(equal, []);

    const behind = collectVersionAuditFailures({
      packages: [{
        name: "@tjalve/aie",
        packageJson: "products/aie/package.json",
        published: true,
        latestPublished: "0.2.5",
        selectedVersion: "0.2.3",
      }],
    }, relativePath => manifests[relativePath]);
    assert.equal(behind.length, 1);
    assert.match(behind[0], /must not be behind/);
  });

  it("rejects a publishable package missing from the version audit", () => {
    const failures = collectVersionAuditFailures(
      { packages: [] },
      () => { throw new Error("unexpected manifest read"); },
      [{ packageJson: "adapters/cursor/package.json" }]
    );
    assert.deepEqual(failures, ["adapters/cursor/package.json: publishable package is missing from docs/release/version-audit.json"]);
  });
});
