import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { planQubeCli } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../dist/bin/qube.js", import.meta.url));

function createWorkspace(name) {
  const cwd = mkdtempSync(path.join(tmpdir(), `${name}-workspace-`));
  const home = mkdtempSync(path.join(tmpdir(), `${name}-home-`));
  const install = mkdtempSync(path.join(tmpdir(), `${name}-install-`));
  return { cwd, home, install };
}

function runCli(args, workspace, cwd = workspace.cwd) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: workspace.home,
      HOME: workspace.home,
      QUBE_TEST_PACKAGE_ROOT: workspace.install,
    },
  });
}

describe("workspace mode", () => {
  it("reports shipping mode in a plain folder without Git or provider configuration", () => {
    const workspace = createWorkspace("qube-mode-plain");
    const result = runCli(["mode", "--json"], workspace);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "mode");
    assert.equal(parsed.mode, "shipping");
    assert.equal(parsed.workspaceRoot, workspace.cwd);
    assert.equal(parsed.configured, false);
    assert.equal(parsed.changed, false);
    assert.deepEqual(parsed.writes, []);
    assert.equal(existsSync(path.join(workspace.cwd, ".qube")), false);
  });

  it("persists local mode and discovers it from nested directories", () => {
    const workspace = createWorkspace("qube-mode-nested");
    const nested = path.join(workspace.cwd, "src", "jobs");
    mkdirSync(nested, { recursive: true });

    const configured = runCli(["mode", "local", "--json"], workspace);
    assert.equal(configured.status, 0, configured.stderr);
    const configuredJson = JSON.parse(configured.stdout);
    assert.equal(configuredJson.mode, "local");
    assert.equal(configuredJson.configured, true);
    assert.equal(configuredJson.changed, true);

    const nestedStatus = runCli(["mode", "--json"], workspace, nested);
    assert.equal(nestedStatus.status, 0, nestedStatus.stderr);
    const nestedJson = JSON.parse(nestedStatus.stdout);
    assert.equal(nestedJson.mode, "local");
    assert.equal(nestedJson.workspaceRoot, workspace.cwd);
    assert.equal(nestedJson.configPath, path.join(workspace.cwd, ".qube", "mode.json"));
  });

  it("plans mode changes without writing and preserves unrelated workspace files", () => {
    const workspace = createWorkspace("qube-mode-dry-run");
    const sourcePath = path.join(workspace.cwd, "service.py");
    writeFileSync(sourcePath, "print('keep me')\n", "utf8");

    const dryRun = runCli(["mode", "local", "--dry-run", "--json"], workspace);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunJson = JSON.parse(dryRun.stdout);
    assert.equal(dryRunJson.mode, "local");
    assert.equal(dryRunJson.dryRun, true);
    assert.equal(dryRunJson.changed, true);
    assert.ok(dryRunJson.writes.includes(path.join(workspace.cwd, "AGENTS.md")));
    assert.ok(dryRunJson.writes.includes(path.join(workspace.cwd, ".qube", "mode.json")));
    assert.equal(existsSync(path.join(workspace.cwd, "AGENTS.md")), false);
    assert.equal(existsSync(path.join(workspace.cwd, ".qube")), false);
    assert.equal(readFileSync(sourcePath, "utf8"), "print('keep me')\n");
  });

  it("keeps the synchronous planning API free of workspace writes", () => {
    const workspace = createWorkspace("qube-mode-plan-api");
    const planned = planQubeCli(["mode", "local", "--json"], {
      cwd: workspace.cwd,
      env: {},
      packageRoot: workspace.install,
    });

    assert.equal(planned.exitCode, 0, planned.stderr);
    const parsed = JSON.parse(planned.stdout);
    assert.equal(parsed.mode, "local");
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.changed, true);
    assert.equal(existsSync(path.join(workspace.cwd, "AGENTS.md")), false);
    assert.equal(existsSync(path.join(workspace.cwd, ".qube")), false);
  });

  it("returns to shipping mode without starting work or changing unrelated instructions", () => {
    const workspace = createWorkspace("qube-mode-shipping");
    const instructionsPath = path.join(workspace.cwd, "AGENTS.md");
    writeFileSync(instructionsPath, "# Project instructions\n\nKeep this text.\n", "utf8");

    assert.equal(runCli(["mode", "local"], workspace).status, 0);
    const localInstructions = readFileSync(instructionsPath, "utf8");
    assert.match(localInstructions, /Keep this text\./);
    assert.match(localInstructions, /BEGIN QUBE WORKSPACE MODE/);

    const shipping = runCli(["mode", "shipping", "--json"], workspace);
    assert.equal(shipping.status, 0, shipping.stderr);
    const parsed = JSON.parse(shipping.stdout);
    assert.equal(parsed.mode, "shipping");
    assert.equal(parsed.configured, true);
    assert.match(readFileSync(instructionsPath, "utf8"), /Keep this text\./);
    assert.equal(existsSync(path.join(workspace.cwd, ".git")), false);
  });

  it("surfaces malformed state in human and JSON output", () => {
    const workspace = createWorkspace("qube-mode-malformed");
    mkdirSync(path.join(workspace.cwd, ".qube"));
    writeFileSync(path.join(workspace.cwd, ".qube", "mode.json"), "{\"version\":1,\"mode\":\"unknown\"}\n", "utf8");

    const human = runCli(["mode"], workspace);
    assert.equal(human.status, 2);
    assert.match(human.stderr, /Cannot read or update the workspace mode/);
    assert.match(human.stderr, /mode local or shipping/);

    const json = runCli(["make-it-so", "Repair the parser", "--json"], workspace);
    assert.equal(json.status, 2);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "make-it-so");
    assert.equal(parsed.error.kind, "workspace-mode-error");
    assert.match(parsed.error.likelyCause, /Cannot read workspace mode/);
  });

  it("prints a reusable domain-neutral prompt with mode status", () => {
    const workspace = createWorkspace("qube-mode-prompt");
    const result = runCli(["mode", "--prompt", "--json"], workspace);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, "shipping");
    assert.equal(parsed.workspaceRoot, workspace.cwd);
    assert.match(parsed.prompt, /Implement the user's requested result/);
    assert.match(parsed.prompt, /Run checks appropriate to the changes/);
    assert.doesNotMatch(parsed.prompt, /frontend|mockup|demo data/i);
  });

  it("renders local make-it-so requests before component or provider resolution", () => {
    const workspace = createWorkspace("qube-mode-request");
    assert.equal(runCli(["mode", "local"], workspace).status, 0);
    const marker = path.join(workspace.cwd, "interpolated.txt");
    const request = `Build a Python backend that stores records in SQLite. Keep this literal: $(New-Item '${marker}')`;

    const result = runCli(["make-it-so", request, "--json"], workspace);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "make-it-so");
    assert.equal(parsed.mode, "local");
    assert.equal(parsed.request, request);
    assert.match(parsed.prompt, /Build a Python backend that stores records in SQLite/);
    assert.doesNotMatch(parsed.prompt, /frontend|mockup|demo data/i);
    assert.equal(existsSync(marker), false);

    const shippingFlowRequest = runCli(["make-it-so", "--flow", "issue", "next", "--json"], workspace);
    assert.equal(shippingFlowRequest.status, 0, shippingFlowRequest.stderr);
    const shippingFlowJson = JSON.parse(shippingFlowRequest.stdout);
    assert.equal(shippingFlowJson.mode, "local");
    assert.equal(shippingFlowJson.request, "next");
    assert.match(shippingFlowJson.prompt, /Requested work:\n\nnext/);
  });
});
