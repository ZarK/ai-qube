import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
