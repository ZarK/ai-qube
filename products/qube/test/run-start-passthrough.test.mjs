import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function runQube(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("run start passthrough", () => {
  it("forwards app flags after -- through qube aie run start", () => {
    const result = runQube([
      "aie", "run", "start", "--name", "ui-audit", "--dry-run", "--json", "--",
      "node", "app.mjs", "--dev", "--", "--host", "127.0.0.1",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.commandLine, ["node", "app.mjs", "--dev", "--", "--host", "127.0.0.1"]);
    assert.deepEqual(parsed.spawnPlan.args, parsed.commandLine.slice(1));
  });

  it("forwards app flags after -- through qube run aie run start", () => {
    const result = runQube([
      "run", "aie", "run", "start", "--name", "ui-audit", "--dry-run", "--json", "--",
      "node", "app.mjs", "--dev",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.commandLine, ["node", "app.mjs", "--dev"]);
  });

  it("forwards app flags after -- through qube app start", () => {
    const result = runQube([
      "app", "start", "--name", "ui-audit", "--dry-run", "--json", "--",
      "npm", "run", "dev", "--", "--host", "127.0.0.1",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.commandLine, ["npm", "run", "dev", "--", "--host", "127.0.0.1"]);
  });

  it("still rejects unknown AIE flags before --", () => {
    const result = runQube(["aie", "run", "start", "--dev", "--", "node", "app.mjs"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unknown-flag|--dev/);
  });
});
