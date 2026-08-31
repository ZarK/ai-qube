import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claudeCodeContinuationAdapter, claudeCodeHostProfile } from "../dist/index.js";

describe("claude-code adapter", () => {
  it("owns a Claude Code Stop codec independent of Codex", () => {
    const payload = { cwd: "/repo", hook_event_name: "Stop", session_id: "claude-1", turn_id: "t1", permission_mode: "default", model: "claude", stop_hook_active: false };
    const decoded = claudeCodeContinuationAdapter.decodeEvent(payload);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.event.sessionId, "claude-1");
    assert.deepEqual(claudeCodeContinuationAdapter.encodeResponse({ decision: "allow" }).response, {});
    assert.equal(claudeCodeContinuationAdapter.decodeEvent({ ...payload, hook_event_name: "PreToolUse" }).ok, false);
  });
  it("exposes one canonical Claude Code host profile", () => {
    assert.equal(claudeCodeHostProfile.id, "claude-code");
    assert.deepEqual(claudeCodeHostProfile.executables, { names: ["claude"], windowsNames: ["claude.exe"] });
    assert.equal(claudeCodeHostProfile.instructionTarget.path, "CLAUDE.md");
    assert.deepEqual(claudeCodeHostProfile.taskList.tools, ["TodoWrite", "TodoRead"]);
    assert.equal(claudeCodeHostProfile.makeItSo.path, ".claude/commands/make-it-so.md");
    assert.equal(claudeCodeHostProfile.makeItSo.kind, "command");
    assert.equal(claudeCodeHostProfile.makeItSo.invocation, "/make-it-so");
    assert.equal("commandTargets" in claudeCodeHostProfile, false);
    assert.equal("instructionTargets" in claudeCodeHostProfile, false);
    assert.equal("todo" in claudeCodeHostProfile, false);
    assert.equal("dialogue" in claudeCodeHostProfile, false);
    assert.equal("hooks" in claudeCodeHostProfile, false);
    assert.equal("supportsProjectCommands" in claudeCodeHostProfile, false);
    assert.equal(claudeCodeHostProfile.review.local.support, "supported");
    assert.equal(claudeCodeHostProfile.review.local.readOnly, true);
    assert.match(claudeCodeHostProfile.review.local.description, /returns one candidate lane result to the main session/);
    assert.doesNotMatch(claudeCodeHostProfile.review.local.description, /writes only named review evidence|invokes QUBE's configured publisher/);
    assert.deepEqual(claudeCodeHostProfile.review.local.agents.map((target) => target.renderer), [
      "claude-review-focus-agent",
      "claude-review-explorer-agent",
      "claude-review-digest-agent",
      "claude-review-librarian-agent",
    ]);
    assert.equal(claudeCodeHostProfile.review.isolated.support, "unsupported");
    assert.deepEqual(claudeCodeHostProfile.review.isolated.agents, []);
    assert.equal(claudeCodeHostProfile.modelDiscovery.support, "unsupported");
    assert.equal("executableNames" in claudeCodeHostProfile.modelDiscovery, false);
    assert.equal(claudeCodeHostProfile.umpire.continuation.support, "experimental");
    assert.equal(claudeCodeHostProfile.umpire.continuation.currentIssueRecovery, true);
    assert.deepEqual(claudeCodeHostProfile.umpire.probe.command, ["qube", "aiu", "doctor", "--json"]);
    assert.equal(claudeCodeHostProfile.trust.required, true);
    assert.deepEqual(claudeCodeHostProfile.trust.actions[0].paths, [".claude/settings.json"]);
  });

  it("does not present CLI help examples as an account model catalog", () => {
    assert.equal(claudeCodeHostProfile.modelDiscovery.support, "unsupported");
    assert.match(claudeCodeHostProfile.modelDiscovery.description, /does not expose/);
    assert.match(claudeCodeHostProfile.modelDiscovery.nextAction, /leaves the native review model unpinned/);
  });
});
