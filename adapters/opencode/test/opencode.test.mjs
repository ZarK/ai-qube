import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOpenCodeVerifyInvocation, isolatedReviewHostAdapter, opencodeContinuationAdapter, opencodeHostProfile, parseOpenCodeModelCatalog, parseOpenCodeOutput } from "../dist/index.js";

describe("opencode adapter", () => {
  it("builds the native continuation verification invocation", () => {
    assert.deepEqual(buildOpenCodeVerifyInvocation({ root: "/repo", prompt: "verify", model: "opencode/test-free", attachUrl: "http://127.0.0.1:4096" }), {
      args: ["run", "--attach", "http://127.0.0.1:4096", "--dir", "/repo", "--format", "json", "--print-logs", "--log-level", "INFO", "--model", "opencode/test-free", "verify"],
    });
  });

  it("exposes one canonical OpenCode host profile", () => {
    assert.equal(opencodeHostProfile.id, "opencode");
    assert.deepEqual(opencodeHostProfile.executables, { names: ["opencode"], windowsNames: ["opencode.exe"] });
    assert.equal(opencodeHostProfile.instructionTarget.path, "AGENTS.md");
    assert.equal(opencodeHostProfile.makeItSo.path, ".opencode/commands/make-it-so.md");
    assert.equal(opencodeHostProfile.makeItSo.kind, "command");
    assert.equal(opencodeHostProfile.makeItSo.invocation, "/make-it-so");
    assert.equal("commandTargets" in opencodeHostProfile, false);
    assert.equal("instructionTargets" in opencodeHostProfile, false);
    assert.equal("todo" in opencodeHostProfile, false);
    assert.equal("dialogue" in opencodeHostProfile, false);
    assert.equal("hooks" in opencodeHostProfile, false);
    assert.equal("supportsProjectCommands" in opencodeHostProfile, false);
    assert.deepEqual(opencodeHostProfile.taskList.tools, ["todowrite", "todoread"]);
    assert.equal(opencodeHostProfile.subagents.support, "supported");
    assert.equal(opencodeHostProfile.review.local.support, "supported");
    assert.equal(opencodeHostProfile.review.local.readOnly, true);
    assert.match(opencodeHostProfile.review.local.description, /returns one candidate lane result to the main session/);
    assert.doesNotMatch(opencodeHostProfile.review.local.description, /writes only named review evidence|invokes QUBE's configured publisher/);
    assert.deepEqual(opencodeHostProfile.review.local.agents.map((target) => target.renderer), [
      "opencode-review-focus-agent",
      "opencode-review-explorer-agent",
      "opencode-review-digest-agent",
      "opencode-review-librarian-agent",
    ]);
    assert.equal(opencodeHostProfile.review.isolated.support, "supported");
    assert.equal(opencodeHostProfile.review.isolated.readOnly, true);
    assert.equal(opencodeHostProfile.review.isolated.freshContext, true);
    assert.deepEqual(opencodeHostProfile.review.isolated.agents, []);
    assert.equal("executableNames" in opencodeHostProfile.modelDiscovery, false);
    assert.equal(opencodeHostProfile.umpire.continuation.delivery, "host");
    assert.equal(opencodeHostProfile.umpire.continuation.currentIssueRecovery, true);
    assert.deepEqual(opencodeHostProfile.umpire.probe.command, ["qube", "aiu", "doctor", "--json"]);
    assert.equal(opencodeHostProfile.trust.required, true);
    assert.deepEqual(opencodeHostProfile.trust.actions[0]?.paths, [
      ".opencode/package.json",
      ".opencode/plugins/ai-umpire-continuation.ts",
    ]);
  });

  it("runs an isolated review with the read-only plan agent and JSON events", () => {
    const context = {
      repoRoot: "/repo",
      model: "opencode/big-pickle",
      effort: "high",
      maxTurns: 8,
      prompt: "inspect",
      promptPath: null,
      schemaPath: null,
      schemaJson: "{\"type\":\"object\"}",
    };
    const built = isolatedReviewHostAdapter.buildInvocation(context);
    assert.deepEqual(built.args, [
      "run",
      "--format", "json",
      "--agent", "plan",
      "--pure",
      "--dir", "/repo",
      "--model", "opencode/big-pickle",
      "--variant", "high",
    ]);
    assert.match(built.stdin, /^inspect/);
    assert.match(built.stdin, /\{"type":"object"\}$/);
    assert.equal(built.args.includes("--auto"), false);
  });

  it("parses the last OpenCode text event and rejects errors or malformed output", () => {
    const events = [
      JSON.stringify({ type: "step_start", sessionID: "ses-1", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", sessionID: "ses-1", part: { type: "text", text: "{\"status\":\"passed\"}" } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses-1", part: { type: "step-finish", tokens: { total: 20, input: 15, output: 5, cache: { read: 3 } } } }),
    ].join("\n");
    assert.deepEqual(parseOpenCodeOutput(events), {
      text: "{\"status\":\"passed\"}",
      sessionId: "ses-1",
      usage: { inputTokens: 15, outputTokens: 5, cachedInputTokens: 3, totalTokens: 20 },
    });
    assert.equal(parseOpenCodeOutput(JSON.stringify({ type: "error", sessionID: "ses-1", part: { type: "error" } })), null);
    assert.equal(parseOpenCodeOutput("not json"), null);
    assert.equal(parseOpenCodeOutput(`not-json\n${events}`), null);
    assert.equal(parseOpenCodeOutput(`42\n${events}`), null);
    assert.equal(parseOpenCodeOutput(`${JSON.stringify({ type: "text", sessionID: "ses-1" })}\n${events}`), null);
    const malformedText = [
      JSON.stringify({ type: "text", sessionID: "ses-1", part: { type: "text", text: "not-json" } }),
      events,
    ].join("\n");
    assert.equal(parseOpenCodeOutput(malformedText), null);
  });

  it("checks the configured model against the live catalog during probe", () => {
    const runCommand = () => "opencode/big-pickle\nopencode-go/glm-5.1\n";
    const ready = isolatedReviewHostAdapter.probeAfterVersion({
      model: "opencode/big-pickle", executable: "opencode", prefixArgs: [], runCommand, version: "1.18.30",
    });
    assert.deepEqual(ready, { status: "ready", modelListed: true, diagnostic: null });
    const blocked = isolatedReviewHostAdapter.probeAfterVersion({
      model: "opencode/absent", executable: "opencode", prefixArgs: [], runCommand, version: "1.18.30",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.modelListed, false);
  });

  it("discovers live OpenCode models without refreshing the remote catalog", () => {
    assert.deepEqual(
      parseOpenCodeModelCatalog([
        "anthropic/claude-sonnet-4",
        "\u001b[32mopenai/gpt-5.6-luna-high\u001b[0m",
        "openrouter/anthropic/claude-sonnet-4",
        "anthropic/claude-sonnet-4",
        "not a model",
      ].join("\n")),
      ["anthropic/claude-sonnet-4", "openai/gpt-5.6-luna-high", "openrouter/anthropic/claude-sonnet-4"],
    );
    assert.equal(parseOpenCodeModelCatalog("warning: no authenticated providers"), null);

    const calls = [];
    const models = opencodeHostProfile.modelDiscovery.listModels({
      executable: "node",
      prefixArgs: ["opencode-script.js"],
      runCommand(executable, args) {
        calls.push([executable, args]);
        return "anthropic/claude-sonnet-4\nopenai/gpt-5.6-luna-high\n";
      },
    });
    assert.deepEqual(models, ["anthropic/claude-sonnet-4", "openai/gpt-5.6-luna-high"]);
    assert.deepEqual(calls, [["node", ["opencode-script.js", "models"]]]);
    assert.equal(calls[0][1].includes("--refresh"), false);
  });

  it("owns OpenCode continuation events, assets, and selected-session delivery", () => {
    assert.deepEqual(opencodeContinuationAdapter.declaration.triggerEvents, ["session.idle", "session.status", "idle", "session-idle", "session-status"]);
    assert.equal(JSON.stringify(opencodeContinuationAdapter.declaration).toLowerCase().includes("paseo"), false);
    const decoded = opencodeContinuationAdapter.decodeEvent({ type: "session.idle", payload: { sessionId: "s1", selectedSessionId: "s1" } });
    assert.equal(decoded.ok, true);
    assert.equal(decoded.event.sessionId, "s1");
    assert.equal(opencodeContinuationAdapter.decodeEvent(null).code, "malformed-event");
    assert.equal(opencodeContinuationAdapter.decodeEvent({ type: "workspace.ready" }).code, "unsupported-event");
    const incompatibleSurface = opencodeContinuationAdapter.probe({ surface: "stop-hook", version: null });
    assert.equal(incompatibleSurface.status, "blocked");
    assert.match(incompatibleSurface.reason, /Unsupported continuation surface/);
    const encoded = opencodeContinuationAdapter.encodeResponse({ decision: "deliver", sessionId: "s1", cwd: "/repo" });
    assert.equal(encoded.ok, true);
    assert.deepEqual(encoded.response, { path: { id: "s1" }, body: { command: "make-it-so", arguments: "" }, query: { directory: "/repo" } });
    assert.equal(opencodeContinuationAdapter.encodeResponse({ decision: "deliver", sessionId: "s1" }).ok, false);
    const assets = opencodeContinuationAdapter.renderManagedAssets({ packageVersions: { "@tjalve/aiu": "1.2.3" } });
    assert.equal(assets.length, 2);
    assert.match(assets.find((asset) => asset.id === "package-dependency").content, /"@tjalve\/aiu": "1.2.3"/);
  });
});
