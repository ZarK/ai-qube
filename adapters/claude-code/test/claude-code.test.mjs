import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildClaudeCodeVerifyInvocation, claudeCodeContinuationAdapter, claudeCodeHostProfile, isolatedReviewHostAdapter, parseClaudeOutput } from "../dist/index.js";

describe("claude-code adapter", () => {
  it("builds the native continuation verification invocation", () => {
    assert.deepEqual(buildClaudeCodeVerifyInvocation({ prompt: "verify", model: "claude-test" }), {
      args: ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--model", "claude-test", "verify"],
    });
  });

  it("owns a Claude Code Stop codec independent of Codex", () => {
    const payload = { cwd: "/repo", hook_event_name: "Stop", session_id: "claude-1", turn_id: "t1", permission_mode: "default", model: "claude", stop_hook_active: false };
    const decoded = claudeCodeContinuationAdapter.decodeEvent(payload);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.event.sessionId, "claude-1");
    assert.deepEqual(claudeCodeContinuationAdapter.encodeResponse({ decision: "allow" }).response, {});
    assert.equal(claudeCodeContinuationAdapter.decodeEvent({ ...payload, hook_event_name: "PreToolUse" }).ok, false);
    assert.equal(claudeCodeContinuationAdapter.probe({ surface: "plugin-event", version: null }).status, "blocked");
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
    assert.equal(claudeCodeHostProfile.review.isolated.support, "supported");
    assert.equal(claudeCodeHostProfile.review.isolated.readOnly, true);
    assert.equal(claudeCodeHostProfile.review.isolated.freshContext, true);
    assert.deepEqual(claudeCodeHostProfile.review.isolated.agents, []);
    assert.equal(claudeCodeHostProfile.modelDiscovery.support, "unsupported");
    assert.equal("executableNames" in claudeCodeHostProfile.modelDiscovery, false);
    assert.equal(claudeCodeHostProfile.umpire.continuation.support, "experimental");
    assert.equal(claudeCodeHostProfile.umpire.continuation.currentIssueRecovery, true);
    assert.deepEqual(claudeCodeHostProfile.umpire.probe.command, ["qube", "aiu", "doctor", "--json"]);
    assert.equal(claudeCodeHostProfile.trust.required, true);
    assert.deepEqual(claudeCodeHostProfile.trust.actions[0].paths, [".claude/settings.json"]);
  });

  it("runs an isolated review in plan mode with schema-bound JSON output", () => {
    const context = {
      repoRoot: "/repo",
      model: "claude-test",
      effort: "high",
      maxTurns: 8,
      prompt: "inspect",
      promptPath: null,
      schemaPath: null,
      schemaJson: "{\"type\":\"object\"}",
    };
    const built = isolatedReviewHostAdapter.buildInvocation(context);
    assert.deepEqual(built.args, [
      "-p",
      "--output-format", "json",
      "--json-schema", "{\"type\":\"object\"}",
      "--permission-mode", "plan",
      "--no-session-persistence",
      "--model", "claude-test",
      "--effort", "high",
    ]);
    assert.equal(built.stdin, "inspect");
    for (const forbidden of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--resume", "--continue"]) {
      assert.equal(built.args.includes(forbidden), false, forbidden);
    }
  });

  it("parses the Claude result envelope and rejects error or malformed output", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: { status: "passed" },
      session_id: "session-1",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
      modelUsage: { "claude-test": {} },
    });
    assert.deepEqual(parseClaudeOutput(envelope), {
      text: "{\"status\":\"passed\"}",
      sessionId: "session-1",
      reportedModel: "claude-test",
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 16 },
    });
    assert.equal(parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "failed" })), null);
    assert.equal(parseClaudeOutput("not json"), null);
    assert.equal(parseClaudeOutput(JSON.stringify({ type: "other", result: "{}" })), null);
  });

  it("probes capability flags before reporting the route ready", () => {
    const runCommand = (executable, args) => args.includes("auth")
      ? JSON.stringify({ loggedIn: true, authMethod: "oauth" })
      : "Usage: claude --json-schema --permission-mode --output-format";
    const ready = isolatedReviewHostAdapter.probeAfterVersion({
      model: "claude-test",
      executable: "claude",
      prefixArgs: [],
      runCommand,
      version: "2.1.278",
    });
    assert.equal(ready.status, "ready");
    assert.equal(ready.modelListed, null);
    const blocked = isolatedReviewHostAdapter.probeAfterVersion({
      model: null,
      executable: "claude",
      prefixArgs: [],
      runCommand: () => "Usage: claude",
      version: "2.1.278",
    });
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.diagnostic, /--json-schema/);
    const unauthenticated = isolatedReviewHostAdapter.probeAfterVersion({
      model: null,
      executable: "claude",
      prefixArgs: [],
      runCommand: (executable, args) => args.includes("auth")
        ? JSON.stringify({ loggedIn: false, authMethod: "none" })
        : "Usage: claude --json-schema --permission-mode --output-format",
      version: "2.1.278",
    });
    assert.equal(unauthenticated.status, "blocked");
    assert.match(unauthenticated.diagnostic, /not authenticated/);
  });

  it("does not present CLI help examples as an account model catalog", () => {
    assert.equal(claudeCodeHostProfile.modelDiscovery.support, "unsupported");
    assert.match(claudeCodeHostProfile.modelDiscovery.description, /does not expose/);
    assert.match(claudeCodeHostProfile.modelDiscovery.nextAction, /leaves the native review model unpinned/);
  });
});
