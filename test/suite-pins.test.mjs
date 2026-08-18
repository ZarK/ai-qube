import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  alignSuitePins,
  bumpPatch,
  inspectSuitePins,
  resolveSuiteRoot,
} from "../scripts/suite-pins.mjs";
import { inspectAdapterPins, renderAdapterPins, writeAdapterPins } from "../scripts/adapter-pins.mjs";
import { ADAPTER_PACKAGES, validatePackageCatalog } from "../scripts/workspace-packages.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function writePackage(root, relativePath, name, version, dependencies = {}) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ name, version, dependencies }, null, 2)}\n`);
}

function writeSuiteFixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qube-suite-pins-"));
  writePackage(root, "products/qube/package.json", "@tjalve/qube", overrides.qubeVersion ?? "0.2.6", {
    "@tjalve/aib": overrides.qubeAib ?? "0.2.5",
    "@tjalve/aie": overrides.qubeAie ?? "0.2.5",
    "@tjalve/aiq": "0.2.4",
    "@tjalve/aiu": "0.0.7",
    "@tjalve/qube-cli": "0.2.1",
    "@tjalve/qube-core": "0.2.3",
  });
  writePackage(root, "products/aib/package.json", "@tjalve/aib", overrides.aibVersion ?? "0.2.5", {
    "@tjalve/aie": overrides.aibAie ?? "workspace:*",
  });
  writePackage(root, "products/aie/package.json", "@tjalve/aie", overrides.aieVersion ?? "0.2.5");
  writePackage(root, "products/aiq/packages/cli/package.json", "@tjalve/aiq", "0.2.4");
  writePackage(root, "products/aiu/package.json", "@tjalve/aiu", "0.0.7");
  writePackage(root, "packages/qube-cli/package.json", "@tjalve/qube-cli", "0.2.1");
  writePackage(root, "packages/qube-core/package.json", "@tjalve/qube-core", "0.2.3");
  for (const entry of ADAPTER_PACKAGES) {
    writePackage(root, entry.packageJson, entry.name, overrides.adapterVersions?.[entry.name] ?? "0.1.0");
  }
  writeAdapterPins(root);
  mkdirSync(path.join(root, "docs", "release"), { recursive: true });
  writeFileSync(path.join(root, "docs/release/version-audit.json"), `${JSON.stringify({
    packages: [
      { name: "@tjalve/qube", selectedVersion: overrides.qubeVersion ?? "0.2.6", latestPublished: "0.2.5", publishedVersions: ["0.2.5"] },
      { name: "@tjalve/aib", selectedVersion: overrides.aibVersion ?? "0.2.5", latestPublished: "0.2.4", publishedVersions: ["0.2.4"] },
      { name: "@tjalve/aie", selectedVersion: overrides.aieVersion ?? "0.2.5", latestPublished: "0.2.4", publishedVersions: ["0.2.4"] },
    ],
  }, null, 2)}\n`);
  return root;
}

describe("suite pins", () => {
  it("accepts the current workspace composer graph", () => {
    const report = inspectSuitePins(repoRoot);
    assert.equal(report.ok, true, report.failures.join("\n"));
    assert.equal(report.resolvedAie, report.aieVersion);
  });

  it("fails when the composer or Bootstrap Executor pin drifts", () => {
    const splitQube = writeSuiteFixture({ qubeAie: "0.2.4" });
    const splitAib = writeSuiteFixture({ aibAie: "0.2.4" });
    try {
      const qubeReport = inspectSuitePins(splitQube);
      assert.equal(qubeReport.ok, false);
      assert.match(qubeReport.failures.join("\n"), /@tjalve\/aie@0\.2\.4, expected 0\.2\.5/);

      const aibReport = inspectSuitePins(splitAib);
      assert.equal(aibReport.ok, false);
      assert.match(aibReport.failures.join("\n"), /@tjalve\/aib depends on @tjalve\/aie@0\.2\.4/);
    } finally {
      rmSync(splitQube, { recursive: true, force: true });
      rmSync(splitAib, { recursive: true, force: true });
    }
  });

  it("rewrites drifted pins and bumps only already-public products that must republish", () => {
    const root = writeSuiteFixture({
      aieVersion: "0.2.6",
      qubeAie: "0.2.5",
      aibVersion: "0.2.5",
    });
    try {
      const publishedByName = new Map([
        ["@tjalve/aie", ["0.2.5"]],
        ["@tjalve/aib", ["0.2.5"]],
        ["@tjalve/qube", ["0.2.6"]],
      ]);
      const report = alignSuitePins(root, { publishedByName });
      assert.equal(report.ok, true, report.failures.join("\n"));
      assert.equal(report.wrote, true);
      assert.equal(report.aibVersion, "0.2.6");
      assert.equal(report.qubeVersion, "0.2.7");
      assert.equal(report.expectedPins["@tjalve/aie"], "0.2.6");
      assert.equal(report.expectedPins["@tjalve/aib"], "0.2.6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails stale generated adapter pins and rewrites them with the release pins", () => {
    const root = writeSuiteFixture();
    const github = ADAPTER_PACKAGES.find(entry => entry.name === "@tjalve/qube-adapter-github");
    try {
      writePackage(root, github.packageJson, github.name, "0.1.1");
      const stale = inspectSuitePins(root);
      assert.equal(stale.ok, false);
      assert.match(stale.failures.join("\n"), /adapter_versions\.generated\.ts is stale/);

      const report = alignSuitePins(root, {
        publishedByName: new Map([
          ["@tjalve/qube", ["0.2.6"]],
          ["@tjalve/aib", []],
          ["@tjalve/aie", []],
        ]),
      });
      assert.equal(report.ok, true, report.failures.join("\n"));
      assert.equal(report.qubeVersion, "0.2.7");
      assert.equal(report.adapterPins.ok, true);
      assert.match(renderAdapterPins(root), /"@tjalve\/qube-adapter-github": "0\.1\.1"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates a newly cataloged adapter without a second version table", () => {
    const root = writeSuiteFixture();
    const added = {
      key: "qube-adapter-example",
      name: "@tjalve/qube-adapter-example",
      path: "adapters/example",
      packageJson: "adapters/example/package.json",
    };
    try {
      writePackage(root, added.packageJson, added.name, "1.2.3");
      const entries = [...ADAPTER_PACKAGES, added];
      const output = renderAdapterPins(root, entries);
      assert.match(output, /"@tjalve\/qube-adapter-example": "1\.2\.3"/);
      assert.equal(writeAdapterPins(root, entries).wrote, true);
      assert.equal(inspectAdapterPins(root, entries).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts generated adapter pins with Windows line endings", () => {
    const root = writeSuiteFixture();
    try {
      const outputPath = path.join(root, "products/qube/src/adapter_versions.generated.ts");
      writeFileSync(outputPath, readFileSync(outputPath, "utf8").replace(/\n/g, "\r\n"));
      assert.equal(inspectAdapterPins(root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate catalog rows, missing manifests, and non-exact versions", () => {
    assert.throws(() => validatePackageCatalog([ADAPTER_PACKAGES[0], ADAPTER_PACKAGES[0]]), {
      reasonCode: "duplicate-catalog-entry",
    });
    const missingRoot = writeSuiteFixture();
    const invalidRoot = writeSuiteFixture();
    try {
      rmSync(path.join(missingRoot, ADAPTER_PACKAGES[0].packageJson));
      assert.throws(() => renderAdapterPins(missingRoot), { reasonCode: "invalid-package-path" });
      writePackage(invalidRoot, ADAPTER_PACKAGES[0].packageJson, ADAPTER_PACKAGES[0].name, "workspace:*");
      assert.throws(() => renderAdapterPins(invalidRoot), { reasonCode: "invalid-version" });
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
      rmSync(invalidRoot, { recursive: true, force: true });
    }
  });

  it("refuses to follow a generated pin symlink outside the suite", {
    skip: process.platform === "win32",
  }, () => {
    const root = writeSuiteFixture();
    const outside = mkdtempSync(path.join(os.tmpdir(), "qube-adapter-pins-out-"));
    const outsideFile = path.join(outside, "outside.ts");
    const outputPath = path.join(root, "products/qube/src/adapter_versions.generated.ts");
    try {
      writeFileSync(outsideFile, "preserve\n");
      rmSync(outputPath);
      symlinkSync(outsideFile, outputPath);
      assert.throws(() => inspectAdapterPins(root), { reasonCode: "unsafe-generated-path" });
      assert.throws(() => writeAdapterPins(root), { reasonCode: "unsafe-generated-path" });
      assert.equal(readFileSync(outsideFile, "utf8"), "preserve\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a missing suite and a symlink that escapes the suite root", {
    skip: process.platform === "win32",
  }, () => {
    const missing = mkdtempSync(path.join(os.tmpdir(), "qube-suite-missing-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "qube-suite-out-"));
    const fixture = mkdtempSync(path.join(os.tmpdir(), "qube-suite-link-"));
    try {
      assert.throws(() => resolveSuiteRoot(missing), { reasonCode: "missing-suite" });
      writeFileSync(path.join(outside, "package.json"), "{\"name\":\"escape\"}\n");
      mkdirSync(path.join(fixture, "products", "qube"), { recursive: true });
      symlinkSync(path.join(outside, "package.json"), path.join(fixture, "products", "qube", "package.json"));
      assert.throws(() => resolveSuiteRoot(fixture), { reasonCode: "path-escape" });
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("bumps a patch version without inventing a new major", () => {
    assert.equal(bumpPatch("0.2.5"), "0.2.6");
  });
});
