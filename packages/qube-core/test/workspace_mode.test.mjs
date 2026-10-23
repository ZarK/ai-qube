import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configureWorkspaceMode, readWorkspaceMode, renderLocalDevelopmentPrompt } from "../dist/index.js";

const folder = () => mkdtempSync(join(tmpdir(), "qube-workspace-mode-"));

describe("workspace mode", () => {
  it("uses a plain folder without inheriting user-global setup", () => {
    const home = folder();
    mkdirSync(join(home, ".qube"));
    writeFileSync(join(home, ".qube", "config.json"), '{"version":1}\n');
    const project = join(home, "project");
    mkdirSync(project);
    const result = configureWorkspaceMode(project, "local");
    assert.equal(result.workspaceRoot, project);
    assert.equal(readWorkspaceMode(project).mode, "local");
    assert.equal(existsSync(join(home, ".qube", "mode.json")), false);
    assert.equal(existsSync(join(home, "AGENTS.md")), false);
    assert.equal(existsSync(join(project, ".git")), false);
  });

  it("finds local mode from nested directories and returns to shipping without touching work", () => {
    const root = folder();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "work.py"), 'print("local work")\n');
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/existing\n");
    configureWorkspaceMode(join(root, "src"), "local");
    assert.deepEqual(readWorkspaceMode(join(root, "src", "nested")), {
      mode: "local", workspaceRoot: root, configPath: join(root, ".qube", "mode.json"), configured: true,
    });
    configureWorkspaceMode(join(root, "src", "nested"), "shipping");
    assert.equal(readWorkspaceMode(root).mode, "shipping");
    assert.equal(readFileSync(join(root, "work.py"), "utf8"), 'print("local work")\n');
    assert.equal(readFileSync(join(root, ".git", "HEAD"), "utf8"), "ref: refs/heads/existing\n");
  });

  it("does not cross a nested workspace boundary", () => {
    const root = folder();
    configureWorkspaceMode(root, "local");
    const nested = join(root, "another-project");
    mkdirSync(join(nested, ".git"), { recursive: true });
    assert.equal(readWorkspaceMode(nested).mode, "shipping");
    const plain = join(root, "initialized-project");
    mkdirSync(join(plain, ".qube"), { recursive: true });
    writeFileSync(join(plain, ".qube", "init.json"), '{}\n');
    assert.equal(readWorkspaceMode(plain).workspaceRoot, plain);
    assert.equal(readWorkspaceMode(plain).mode, "shipping");
  });

  it("plans both files without writing and preserves unrelated instructions and config on apply", () => {
    const root = folder();
    const instructions = "# Project\r\n\r\nKeep the user's instructions.\r\n";
    mkdirSync(join(root, ".qube", "aie"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), instructions);
    const config = '{"providers":{"work":{"kind":"github"}}}\n';
    writeFileSync(join(root, ".qube", "aie", "config.json"), config);
    const plan = configureWorkspaceMode(root, "local", { dryRun: true });
    assert.equal(plan.changed, true);
    assert.equal(plan.writes.length, 2);
    assert.equal(existsSync(join(root, ".qube", "mode.json")), false);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), instructions);
    configureWorkspaceMode(root, "local");
    const applied = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.ok(applied.startsWith(instructions));
    assert.match(applied, /qube mode --json/);
    assert.equal(readFileSync(join(root, ".qube", "aie", "config.json"), "utf8"), config);
    assert.equal(configureWorkspaceMode(root, "local").changed, false);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), applied);
  });

  it("rejects malformed and unsupported mode records instead of assuming shipping", () => {
    const root = folder();
    mkdirSync(join(root, ".qube"));
    for (const invalid of ["{", '{"version":2,"mode":"local"}', '{"version":1,"mode":"unknown"}', '{"version":1,"mode":"local","extra":true}']) {
      writeFileSync(join(root, ".qube", "mode.json"), invalid);
      assert.throws(() => readWorkspaceMode(root), /Cannot read workspace mode/);
      assert.throws(() => configureWorkspaceMode(root, "shipping"), /Cannot read workspace mode/);
      assert.equal(readFileSync(join(root, ".qube", "mode.json"), "utf8"), invalid);
      assert.equal(existsSync(join(root, "AGENTS.md")), false);
    }
  });

  it("rejects an incomplete instruction section before writing mode", () => {
    const root = folder();
    const text = "User instructions\n<!-- BEGIN QUBE WORKSPACE MODE -->\nincomplete\n";
    writeFileSync(join(root, "AGENTS.md"), text);
    assert.throws(() => configureWorkspaceMode(root, "local"), /incomplete or duplicate/);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), text);
    assert.equal(existsSync(join(root, ".qube", "mode.json")), false);
  });

  it("does not write through a configuration junction", () => {
    const root = folder();
    const outside = folder();
    symlinkSync(outside, join(root, ".qube"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => configureWorkspaceMode(root, "local"), /symbolic link/);
    assert.equal(existsSync(join(outside, "mode.json")), false);
    assert.equal(existsSync(join(root, "AGENTS.md")), false);
  });

  it("keeps reusable instructions independent of the task's domain", () => {
    const request = "Implement a Python parser for the existing log format.";
    const prompt = renderLocalDevelopmentPrompt(request);
    assert.ok(prompt.includes(request));
    assert.match(prompt, /current agent/);
    assert.match(prompt, /Run checks appropriate/);
    assert.doesNotMatch(renderLocalDevelopmentPrompt(), /frontend|backend|UX|mockup|demo data/i);
    assert.match(prompt, /Do not select issues, create branches, commit, push/);
  });
});
