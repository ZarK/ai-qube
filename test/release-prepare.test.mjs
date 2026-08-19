import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { writeAdapterPins } from "../scripts/adapter-pins.mjs";
import { PUBLISH_PACKAGES, PUBLISH_SET_ORDER } from "../scripts/publish-packages.mjs";
import {
  applyReleasePreparation,
  compareVersions,
  inspectSetTag,
  parseChangedPaths,
  planReleasePreparation,
  prepareRelease,
  resolveReleaseBaseline,
} from "../scripts/prepare-release.mjs";
import { bumpPatch } from "../scripts/suite-pins.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const auditPath = "docs/release/version-audit.json";

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "qube-release-prepare-"));
  const publishedByName = new Map();
  for (const packageKey of PUBLISH_SET_ORDER) {
    const catalog = PUBLISH_PACKAGES.get(packageKey);
    const target = path.join(root, catalog.packageJson);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, catalog.packageJson), target);
    const manifest = JSON.parse(readFileSync(target, "utf8"));
    publishedByName.set(manifest.name, packageKey === "qube-adapter-cursor" ? [] : [manifest.version]);
  }
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), `packages:\n  - "adapters/*"\n  - "packages/*"\n  - "products/aib"\n  - "products/aie"\n  - "products/aiu"\n  - "products/qube"\n  - "products/aiq"\n  - "products/aiq/packages/*"\n`);
  const aiqVersion = JSON.parse(readFileSync(path.join(root, "products/aiq/packages/cli/package.json"), "utf8")).version;
  writeJson(root, "products/aiq/package.json", {
    name: "@tjalve/aiq-workspace-fixture",
    private: true,
    version: aiqVersion,
  });
  writeJson(root, "products/aiq/packages/hook/package.json", {
    name: "@tjalve/aiq-hook-fixture",
    private: true,
    version: aiqVersion,
    dependencies: { "@tjalve/aiq": aiqVersion },
  });
  writeJson(root, auditPath, {
    checkedAt: "2026-08-18",
    registry: "https://registry.npmjs.org/",
    rule: "fixture",
    packages: [],
  });
  writeAdapterPins(root);
  const initial = planReleasePreparation(root, {
    baselineTag: "publish-set-v0.2.8",
    baselineSha: "a".repeat(40),
    changedPaths: [],
    publishedByName,
  });
  applyReleasePreparation(root, initial, publishedByName, { updateLockfile: false });
  return { root, publishedByName };
}

function planFixture(fixture, changedPaths, options = {}) {
  return planReleasePreparation(fixture.root, {
    baselineTag: "publish-set-v0.2.8",
    baselineSha: "a".repeat(40),
    changedPaths,
    publishedByName: fixture.publishedByName,
    ...options,
  });
}

describe("release preparation", () => {
  it("reports a stable prepared workspace without writing files", () => {
    const fixture = createFixture();
    try {
      const corePath = path.join(fixture.root, "packages/qube-core/package.json");
      const before = readFileSync(corePath, "utf8");
      const plan = planFixture(fixture, []);
      assert.equal(plan.needsWrite, false);
      assert.deepEqual(plan.versionChanges, []);
      const applied = applyReleasePreparation(fixture.root, plan, fixture.publishedByName, {
        runner: () => { throw new Error("stable preparation must not install"); },
      });
      assert.equal(applied.wrote, false);
      assert.equal(readFileSync(corePath, "utf8"), before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports complete dry-run evidence without changing generated files", async () => {
    const fixture = createFixture();
    try {
      const corePath = path.join(fixture.root, "packages/qube-core/package.json");
      const before = readFileSync(corePath);
      const report = await prepareRelease({
        repoRoot: fixture.root,
        baseline: { baselineTag: "publish-set-v0.2.8", baselineSha: "a".repeat(40) },
        changedPaths: ["packages/qube-core/src/index.ts"],
        publishedByName: fixture.publishedByName,
        setTagState: { status: "absent", tag: null },
      });
      assert.equal(report.dryRun, true);
      assert.equal(report.baselineTag, "publish-set-v0.2.8");
      assert.deepEqual(report.changedPaths, ["packages/qube-core/src/index.ts"]);
      assert.ok(report.versionChanges.some(change => change.packageKey === "qube-core"));
      assert.ok(report.propagatedPackages.includes("qube"));
      assert.ok(report.stageOrder.length > 0);
      assert.deepEqual(readFileSync(corePath), before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("bumps changed public packages and propagates internal dependency releases", () => {
    const fixture = createFixture();
    try {
      const plan = planFixture(fixture, ["packages/qube-core/src/index.ts"]);
      const reports = new Map(plan.reports.map(report => [report.packageKey, report]));
      assert.equal(reports.get("qube-core").toVersion, bumpPatch(reports.get("qube-core").fromVersion));
      assert.equal(reports.get("qube-adapter-codex").propagated, true);
      assert.equal(
        reports.get("qube-adapter-cursor").toVersion,
        reports.get("qube-adapter-cursor").fromVersion,
      );
      assert.equal(reports.get("aie").propagated, true);
      assert.equal(reports.get("aib").propagated, true);
      assert.equal(reports.get("qube").propagated, true);
      assert.equal(reports.get("qube-cli").toVersion, reports.get("qube-cli").fromVersion);
      assert.ok(plan.stageOrder.findIndex(entry => entry.packageKey === "aie") < plan.stageOrder.findIndex(entry => entry.packageKey === "aib"));
      assert.equal(plan.needsWrite, true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("maps the complete AIQ workspace and preserves an unpublished initial adapter version", () => {
    const fixture = createFixture();
    try {
      const aiq = planFixture(fixture, ["products/aiq/scripts/build.mjs"]);
      assert.deepEqual(aiq.directPackages, ["aiq"]);
      assert.equal(aiq.versionChanges[0].packageKey, "aiq");
      assert.deepEqual(aiq.workspaceChanges.map(change => change.packageJson), [
        "products/aiq/package.json",
        "products/aiq/packages/hook/package.json",
      ]);
      assert.equal(aiq.workspaceChanges.every(change => change.versionChange?.to === aiq.versionChanges[0].to), true);

      const cursor = planFixture(fixture, ["adapters/cursor/src/index.ts"]);
      const cursorReport = cursor.reports.find(report => report.packageKey === "qube-adapter-cursor");
      assert.equal(cursorReport.direct, true);
      assert.equal(cursorReport.toVersion, cursorReport.fromVersion);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("advances only the composer when its immutable set tag belongs to an older commit", () => {
    const fixture = createFixture();
    try {
      const aie = JSON.parse(readFileSync(path.join(fixture.root, "products/aie/package.json"), "utf8"));
      const qube = JSON.parse(readFileSync(path.join(fixture.root, "products/qube/package.json"), "utf8"));
      fixture.publishedByName.set(aie.name, ["0.2.6"]);
      fixture.publishedByName.set(qube.name, ["0.2.8"]);
      const currentPlan = planFixture(fixture, ["products/aie/src/app/model_review_runner.ts"], {
        setTagState: { status: "current", tag: `publish-set-v${qube.version}` },
      });
      assert.equal(currentPlan.reports.find(report => report.packageKey === "qube").toVersion, qube.version);
      assert.deepEqual(currentPlan.replacementPackages, []);
      const plan = planFixture(fixture, ["products/aie/src/app/model_review_runner.ts"], {
        setTagState: { status: "occupied", tag: `publish-set-v${qube.version}` },
      });
      const versions = new Map(plan.reports.map(report => [report.packageKey, report.toVersion]));
      assert.equal(versions.get("aie"), aie.version);
      assert.equal(versions.get("qube"), bumpPatch(qube.version));
      assert.equal(plan.setTag, `publish-set-v${bumpPatch(qube.version)}`);
      assert.equal(plan.replacesSetTag, `publish-set-v${qube.version}`);
      assert.deepEqual(plan.replacementPackages, ["qube"]);
      assert.deepEqual(plan.versionChanges, [{
        packageKey: "qube",
        packageName: "@tjalve/qube",
        from: qube.version,
        to: bumpPatch(qube.version),
      }]);
      assert.throws(() => planFixture(fixture, [], {
        setTagState: { status: "occupied", tag: "publish-set-v9.9.9" },
      }), { reasonCode: "set-tag-state" });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for incomplete registry evidence and version drift", () => {
    const missing = createFixture();
    const drift = createFixture();
    try {
      missing.publishedByName.delete("@tjalve/qube-core");
      assert.throws(() => planFixture(missing, ["packages/qube-core/src/index.ts"]), { reasonCode: "registry-lookup" });

      const core = JSON.parse(readFileSync(path.join(drift.root, "packages/qube-core/package.json"), "utf8"));
      drift.publishedByName.set(core.name, [core.version, bumpPatch(core.version)]);
      assert.throws(() => planFixture(drift, ["packages/qube-core/src/index.ts"]), { reasonCode: "registry-version-drift" });
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
      rmSync(drift.root, { recursive: true, force: true });
    }
  });

  it("rolls every generated file back when the protected workspace install fails", () => {
    const fixture = createFixture();
    try {
      const lockfilePath = path.join(fixture.root, "pnpm-lock.yaml");
      writeFileSync(lockfilePath, "lockfileVersion: '9.0'\n");
      const trackedPaths = [
        "packages/qube-core/package.json",
        "products/qube/package.json",
        "products/qube/src/adapter_versions.generated.ts",
        auditPath,
        "pnpm-lock.yaml",
      ];
      const before = new Map(trackedPaths.map(relativePath => [relativePath, readFileSync(path.join(fixture.root, relativePath))]));
      const plan = planFixture(fixture, ["packages/qube-core/src/index.ts"]);
      let invocation;
      assert.throws(
        () => applyReleasePreparation(fixture.root, plan, fixture.publishedByName, {
          runner: (command, args) => {
            invocation = { command, args };
            return { status: 1 };
          },
        }),
        { reasonCode: "workspace-install" }
      );
      assert.ok(invocation.args.join(" ").includes("install --ignore-scripts --config.verify-deps-before-run=false"));
      if (process.platform === "win32") assert.equal(invocation.command, "cmd.exe");
      for (const [relativePath, contents] of before) {
        assert.deepEqual(readFileSync(path.join(fixture.root, relativePath)), contents);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("validates baseline tags, changed paths, and semantic version order", () => {
    const git = {
      run(args) {
        if (args[0] === "tag") return "publish-set-v0.2.8\npublish-set-not-a-version\n";
        if (args[0] === "rev-list") return "b".repeat(40);
        return "";
      },
    };
    assert.deepEqual(resolveReleaseBaseline(repoRoot, git), {
      baselineTag: "publish-set-v0.2.8",
      baselineSha: "b".repeat(40),
    });
    assert.throws(
      () => resolveReleaseBaseline(repoRoot, { run: () => "publish-set-not-a-version\n" }),
      { reasonCode: "release-baseline" }
    );
    const excludingGit = {
      run(args) {
        if (args[0] === "tag") return "publish-set-v0.2.9\npublish-set-v0.2.8\n";
        if (args[0] === "rev-list") return "c".repeat(40);
        return "";
      },
    };
    assert.equal(resolveReleaseBaseline(repoRoot, excludingGit, { excludeTag: "publish-set-v0.2.9" }).baselineTag, "publish-set-v0.2.8");
    assert.throws(() => parseChangedPaths("../escape\0"), { reasonCode: "unsafe-changed-path" });
    assert.equal(compareVersions("0.2.8-rc.1", "0.2.8"), -1);
    assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
    assert.equal(compareVersions("1.0.0-B", "1.0.0-a"), -1);
  });

  it("distinguishes absent, current, occupied, conflicting, and unreadable set tags", () => {
    const head = "a".repeat(40);
    const older = "b".repeat(40);
    const tagObject = "c".repeat(40);
    const tag = "publish-set-v0.2.9";
    const inspect = overrides => inspectSetTag(repoRoot, "0.2.9", {
      run(args) {
        if (args[0] === "rev-parse" && args[1] !== "--verify") return head;
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          if (args[2] === `${tag}^{commit}`) return overrides.localSha ?? head;
          return overrides.remoteCommit ?? overrides.remotePeeled ?? overrides.remoteDirect ?? head;
        }
        if (args[0] === "tag") return overrides.localName ?? "";
        if (args[0] === "ls-remote") return overrides.remote ?? "";
        if (args[0] === "fetch") return "";
        return "";
      },
    });
    assert.equal(inspect({}).status, "absent");
    assert.equal(inspect({
      localName: tag,
      localSha: head,
      remote: `${tagObject}\trefs/tags/${tag}\n${head}\trefs/tags/${tag}^{}\n`,
      remotePeeled: head,
    }).status, "current");
    assert.equal(inspect({
      remote: `${older}\trefs/tags/${tag}\n`,
      remoteDirect: older,
    }).status, "occupied");
    assert.throws(() => inspect({
      localName: tag,
      localSha: head,
      remote: `${older}\trefs/tags/${tag}\n`,
      remoteDirect: older,
    }), { reasonCode: "set-tag-conflict" });
    assert.throws(() => inspectSetTag(repoRoot, "0.2.9", {
      run(args) {
        if (args[0] === "rev-parse" && args[1] !== "--verify") return head;
        if (args[0] === "tag") return "";
        if (args[0] === "ls-remote") return `${older}\trefs/tags/${tag}\n`;
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("tag target is not a commit");
        return "";
      },
    }), { reasonCode: "set-tag-state" });
    assert.throws(() => inspectSetTag(repoRoot, "0.2.9", {
      run() { throw new Error("unreadable"); },
    }), { reasonCode: "set-tag-state" });
  });
});
