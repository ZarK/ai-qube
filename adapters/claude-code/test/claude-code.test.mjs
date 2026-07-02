import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assertClaudeCodeOperationAvailable,
  claudeCodeAdapter,
  claudeCodeHostProfile,
  formatClaudeCodeUnsupportedOperationMessage,
  getClaudeCodeOperationSupport,
  inspectClaudeCodeWorkspace,
  listClaudeCodeInstallFiles,
  listClaudeCodeInstallNotes,
  listClaudeCodeOperationSupport,
} from "../dist/index.js";

describe("claude-code adapter", () => {
  it("registers the claude-code adapter contract", () => {
    assert.equal(claudeCodeAdapter.id, "claude-code");
    assert.equal(claudeCodeAdapter.packageName, "@tjalve/qube-adapter-claude-code");
  });

  it("exposes the claude-code host profile", () => {
    assert.equal(claudeCodeHostProfile.id, "claude-code");
    assert.equal(claudeCodeHostProfile.instructionTargets[0].path, "CLAUDE.md");
    assert.deepEqual(claudeCodeHostProfile.todo.tools, ["TodoWrite", "TodoRead"]);
    assert.equal(claudeCodeHostProfile.supportsProjectCommands, false);
  });

  it("reports claude-code capabilities from workspace inspection", () => {
    const capabilities = listClaudeCodeOperationSupport();
    assert.equal(capabilities.filter((capability) => capability.support === "supported").length, 3);
    assert.equal(capabilities.filter((capability) => capability.support === "host-provided").length, 6);
    assert.equal(capabilities.filter((capability) => capability.support === "unsupported").length, 4);
    assert.equal(new Set(capabilities.map((capability) => capability.id)).size, capabilities.length);

    assert.equal(assertClaudeCodeOperationAvailable("read-instructions").support, "supported");
    assert.equal(getClaudeCodeOperationSupport("install-slash-command").support, "unsupported");
    assert.deepEqual(getClaudeCodeOperationSupport("use-task-state").tools, ["TodoWrite", "TodoRead"]);
    assert.deepEqual(listClaudeCodeInstallFiles(), [
      "CLAUDE.md policy notes: Claude Code project instructions use CLAUDE.md with repository policy precedence.",
      ".claude/settings.json hook notes: Claude Code hooks are configured through host settings and can observe lifecycle events such as tool use and Stop.",
    ]);
    assert.equal(listClaudeCodeInstallNotes().length, 5);

    const unknownCapability = getClaudeCodeOperationSupport("completely-unknown-id");
    assert.equal(unknownCapability.support, "unsupported");
    assert.match(formatClaudeCodeUnsupportedOperationMessage(unknownCapability), /completely-unknown-id/);
    assert.throws(() => assertClaudeCodeOperationAvailable("install-slash-command"), /Unsupported Claude Code capability/);

    const repo = mkdtempSync(path.join(tmpdir(), "qube-claude-code-host-"));
    writeFileSync(path.join(repo, "CLAUDE.md"), "Repository policy\n");
    mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
    writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");
    const inspection = inspectClaudeCodeWorkspace(repo);

    assert.equal(inspection.cwd, repo);
    assert.equal(inspection.instructionTarget.present, true);
    assert.equal(path.basename(inspection.instructionTarget.path), "CLAUDE.md");
    assert.equal(inspection.settingsDirectory.present, true);
    assert.equal(inspection.projectSettings.present, true);
    assert.equal(inspection.localSettings.present, false);
    assert.equal(inspection.commandDirectory.present, true);
    assert.equal(inspection.skillsDirectory.present, true);
    assert.ok(inspection.capabilities.some((capability) => capability.id === "use-task-state"));
    assert.ok(inspection.unsupportedCapabilities.some((capability) => capability.id === "open-pull-request"));
    assert.throws(() => inspection.capabilities.push(inspection.capabilities[0]), TypeError);
    assert.throws(() => {
      inspection.capabilities[0].summary = "mutated";
    }, TypeError);

    const repoWithoutInstructions = mkdtempSync(path.join(tmpdir(), "qube-claude-code-host-missing-"));
    const missingInspection = inspectClaudeCodeWorkspace(repoWithoutInstructions);
    assert.equal(missingInspection.instructionTarget.present, false);
    assert.equal(missingInspection.settingsDirectory.present, false);
  });
});
