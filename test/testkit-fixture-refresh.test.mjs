import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "refresh-testkit-fixtures.mjs");

function runRefresh(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("testkit fixture refresh", () => {
  it("checks a fixture under the testkit package", () => {
    const result = runRefresh(["check", "package.json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.path, "package.json");
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  });

  it("refuses an absolute fixture path", () => {
    const result = runRefresh(["check", path.resolve(repoRoot, "package.json")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /relative/);
  });

  it("refuses a parent-directory fixture path", () => {
    const result = runRefresh(["check", "../package.json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parent-directory/);
  });
});
