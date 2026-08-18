import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { collectVersionAuditFailures } from "../scripts/check-version-audit.mjs";
import {
  finalizePublishPlan,
  inspectRetryContents,
  readPublishedVersions,
  readPublishedVersionsForPlan,
  readRegistryPackage,
  registryPackageUrl,
  resolvePublishTag,
} from "../scripts/publish-packages.mjs";
import { resolvePublishPlan } from "../scripts/resolve-publish-tag.mjs";

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

  it("resolves retry tags to the original set version", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const resolved = await resolvePublishTag(`publish-set-v${version}-retry.2`, repoRoot);
    assert.equal(resolved.mode, "set");
    assert.equal(resolved.setVersion, version);
    assert.equal(resolved.retry, 2);
  });

  it("rejects publishable input changes on a retry", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const resolved = await resolvePublishTag(`publish-set-v${version}-retry.1`, repoRoot);
    assert.throws(() => inspectRetryContents(resolved, "original-sha", repoRoot, {
      run() { throw new Error("changed"); },
    }), { reasonCode: "retry-content-drift" });
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
    const missingPackage = await readRegistryPackage("@tjalve/missing-package", {
      fetch: async () => ({ status: 404, ok: false }),
    });
    assert.equal(missingPackage.exists, false);

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

  it("reads independent registry packages concurrently and deduplicates names", async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const versions = await readPublishedVersionsForPlan({
      packages: [
        packageEntry("one", "@tjalve/one", "1.0.0"),
        packageEntry("two", "@tjalve/two", "1.0.0"),
        packageEntry("one-again", "@tjalve/one", "1.0.0"),
      ],
    }, {
      fetch: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, status: 200, json: async () => ({ versions: { "1.0.0": {} } }) };
      },
    });
    assert.equal(calls, 2);
    assert.equal(maximumActive, 2);
    assert.deepEqual(versions.get("@tjalve/one"), ["1.0.0"]);
  });

  it("enforces generated preparation even when a set tag is pushed manually", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const tag = `publish-set-v${version}`;
    const resolved = await resolvePublishTag(tag, repoRoot);
    const publishedByName = new Map(resolved.packages.map(entry => [
      entry.packageName,
      entry.packageKey === "qube" ? [] : [entry.version],
    ]));
    let preparationOptions;
    const plan = await resolvePublishPlan(tag, {
      root: repoRoot,
      publishedByName,
      prepareRelease: async options => {
        preparationOptions = options;
        return { needsWrite: false };
      },
    });
    assert.equal(plan.packages.length, 1);
    assert.equal(preparationOptions.excludeBaselineTag, tag);

    await assert.rejects(
      () => resolvePublishPlan(tag, {
        root: repoRoot,
        publishedByName,
        prepareRelease: async () => ({ needsWrite: true }),
      }),
      { reasonCode: "release-unprepared" }
    );
  });

  it("creates a fresh partial plan for a valid retry tag", async () => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, "products/qube/package.json"), "utf8")).version;
    const tag = `publish-set-v${version}-retry.1`;
    const resolved = await resolvePublishTag(tag, repoRoot);
    const publishedByName = new Map(resolved.packages.map(entry => [
      entry.packageName,
      entry.packageKey === "qube" ? [] : [entry.version],
    ]));
    let prepared = false;
    const gitCalls = [];
    const plan = await resolvePublishPlan(tag, {
      root: repoRoot,
      publishedByName,
      prepareRelease: async () => { prepared = true; return { needsWrite: false }; },
      git: {
        run(args) {
          gitCalls.push(args.join(" "));
          if (args[0] === "rev-parse") return "original-sha";
          return "";
        },
      },
    });
    assert.equal(prepared, false);
    assert.deepEqual(plan.packages.map(entry => entry.packageKey), ["qube"]);
    assert.equal(plan.skipped.length, resolved.packages.length - 1);
    assert.equal(gitCalls.some(call => call === `rev-parse publish-set-v${version}^{commit}`), true);
    assert.equal(gitCalls.some(call => call === "merge-base --is-ancestor original-sha HEAD"), true);

    const unpublished = new Map(resolved.packages.map(entry => [entry.packageName, []]));
    await assert.rejects(
      () => resolvePublishPlan(tag, {
        root: repoRoot,
        publishedByName: unpublished,
        git: { run: args => args[0] === "rev-parse" ? "original-sha" : "" },
      }),
      { reasonCode: "retry-unnecessary" }
    );
  });
});
