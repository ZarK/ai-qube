import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "check-strict-package-json.mjs");

function runCheck(args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

describe("strict publishable package.json", () => {
  it("accepts every audited publishable package.json as strict JSON", () => {
    const result = runCheck();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.files.includes("products/qube/package.json"));
  });

  it("fails when a publishable package.json is truncated", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-strict-json-"));
    const broken = path.join(root, "package.json");
    writeFileSync(broken, "{ \"name\": \"@tjalve/truncated\", \"version\": \"0.0.1\"");
    const result = runCheck(["--only", broken]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON|Unexpected|End of|truncated|position/i);
  });

  it("fails when a publishable package.json has a trailing comma", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-strict-json-comma-"));
    const broken = path.join(root, "package.json");
    writeFileSync(broken, "{ \"name\": \"@tjalve/trailing\", \"version\": \"0.0.1\", }\n");
    const result = runCheck(["--only", broken]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON|Unexpected|token|comma/i);
  });

  it("fails when a publishable package.json starts with a UTF-8 BOM", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qube-strict-json-bom-"));
    const broken = path.join(root, "package.json");
    writeFileSync(broken, `\uFEFF${JSON.stringify({ name: "@tjalve/bom", version: "0.0.1" })}\n`);
    const result = runCheck(["--only", broken]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BOM/);
  });
});
