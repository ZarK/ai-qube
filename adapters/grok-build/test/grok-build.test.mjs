import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const adapter = require("../dist/index.js");

describe("grok-build adapter", () => {
  it("depends only on core and exports the canonical host profile", () => {
    const manifest = require("../package.json");
    assert.deepEqual(Object.keys(manifest.dependencies), ["@tjalve/qube-core"]);
    assert.equal(adapter.isolatedReviewHostAdapter.id, "grok-build");
    assert.equal(adapter.grokBuildRouteRunnerPath.replaceAll("\\", "/"), ".grok/agents/qube-route-runner.md");
    assert.deepEqual([...adapter.isolatedReviewHostAdapter.executableNames], ["grok"]);
    assert.equal(adapter.grokBuildHostProfile.id, "grok-build");
    assert.deepEqual(adapter.grokBuildHostProfile.executables, { names: ["grok"], windowsNames: ["grok.exe"] });
    assert.equal(adapter.grokBuildHostProfile.instructionTarget.path, "AGENTS.md");
    assert.equal(adapter.grokBuildHostProfile.makeItSo.path, ".grok/commands/make-it-so.md");
    assert.equal(adapter.grokBuildHostProfile.makeItSo.invocation, "/make-it-so");
    assert.equal("commandTargets" in adapter.grokBuildHostProfile, false);
    assert.equal("instructionTargets" in adapter.grokBuildHostProfile, false);
    assert.equal("todo" in adapter.grokBuildHostProfile, false);
    assert.equal("dialogue" in adapter.grokBuildHostProfile, false);
    assert.equal("hooks" in adapter.grokBuildHostProfile, false);
    assert.equal("supportsProjectCommands" in adapter.grokBuildHostProfile, false);
    assert.equal(adapter.grokBuildHostProfile.taskList.support, "unsupported");
    assert.equal(adapter.grokBuildHostProfile.subagents.support, "supported");
    assert.equal(adapter.grokBuildHostProfile.review.local.support, "supported");
    assert.equal(adapter.grokBuildHostProfile.review.local.readOnly, true);
    assert.match(adapter.grokBuildHostProfile.review.local.description, /returns one candidate lane result to the main session/);
    assert.doesNotMatch(adapter.grokBuildHostProfile.review.local.description, /writes only named review evidence|invokes QUBE's configured publisher/);
    assert.deepEqual(adapter.grokBuildHostProfile.review.local.agents.map((target) => target.renderer), [
      "grok-review-focus-agent",
      "grok-review-explorer-agent",
      "grok-review-digest-agent",
      "grok-review-librarian-agent",
    ]);
    assert.equal(adapter.grokBuildHostProfile.review.isolated.support, "supported");
    assert.deepEqual(adapter.grokBuildHostProfile.review.isolated.agents, []);
    assert.equal(adapter.grokBuildHostProfile.modelDiscovery.support, "supported");
    assert.equal("executableNames" in adapter.grokBuildHostProfile.modelDiscovery, false);
    assert.equal(adapter.grokBuildHostProfile.umpire.continuation.support, "experimental");
    assert.equal(adapter.grokBuildHostProfile.umpire.continuation.currentIssueRecovery, true);
    assert.deepEqual(adapter.grokBuildHostProfile.umpire.probe.command, ["qube", "aiu", "doctor", "--json"]);
    assert.deepEqual(adapter.grokBuildHostProfile.trust.actions[0].paths, [".grok/hooks/ai-umpire.json"]);
    assert.equal(adapter.grokBuildHostProfile.trust.actions[1].command, "/hooks-trust");
  });

  it("builds isolated-review argv without a product copy", () => {
    const built = adapter.isolatedReviewHostAdapter.buildInvocation({
      repoRoot: "/repo",
      model: "grok-4.5",
      effort: null,
      maxTurns: 8,
      prompt: "inspect",
      promptPath: "/repo/.git/qube/prompt",
      schemaPath: null,
      schemaJson: "{}",
    }, "grok");
    assert.ok(built.args.includes("--prompt-file"));
    assert.ok(built.args.includes("--sandbox"));
    assert.equal(built.stdin, null);
  });

  it("parses grok models output", () => {
    const catalog = adapter.parseGrokModelCatalog("Available models:\n- grok-4.5\n- grok-4.6\n");
    assert.deepEqual(catalog, ["grok-4.5", "grok-4.6"]);

    const calls = [];
    const models = adapter.grokBuildHostProfile.modelDiscovery.listModels({
      executable: "node",
      prefixArgs: ["grok-script.js"],
      runCommand(executable, args) {
        calls.push([executable, args]);
        return "Available models:\n- grok-4.5\n- grok-4.6\n";
      },
    });
    assert.deepEqual(models, ["grok-4.5", "grok-4.6"]);
    assert.deepEqual(calls, [["node", ["grok-script.js", "models"]]]);
  });

  it("separates noisy JSONL progress from the final review payload", () => {
    const progress = JSON.stringify({ status: "pending" });
    const final = JSON.stringify({ status: "passed" });
    const parsed = adapter.isolatedReviewHostAdapter.parseEnvelope([
      "starting review",
      JSON.stringify({ type: "progress", message: "reading" }),
      JSON.stringify({ text: progress, sessionId: "grok-session" }),
      JSON.stringify({ text: final, model: "grok-4.6", usage: { input_tokens: 10 } }),
      JSON.stringify({ type: "telemetry" }),
    ].join("\n"));

    assert.equal(parsed.text, final);
    assert.deepEqual(parsed.transientTexts, [progress]);
    assert.equal(parsed.sessionId, "grok-session");
    assert.equal(parsed.reportedModel, "grok-4.6");
    assert.equal(parsed.usage.inputTokens, 10);
  });

  it("parses a Grok stop-hook payload and rejects Claude snake_case", () => {
    const parsed = adapter.parseGrokStopPayload({
      cwd: "/repo",
      hookEventName: "stop",
      sessionId: "s1",
      stopHookActive: false,
      reason: "end_turn",
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.payload.session_id, "s1");
    assert.equal(adapter.isGrokSessionEndReason("end_turn"), false);
    assert.equal(adapter.isGrokSessionEndReason("abort"), true);
    const rejected = adapter.parseGrokStopPayload({
      cwd: "/repo",
      hook_event_name: "Stop",
      session_id: "s1",
      stop_hook_active: false,
    });
    assert.equal(rejected.ok, false);
  });

  it("owns the Stop hook file content", () => {
    assert.equal(adapter.grokBuildStopHookFile.relativePath.replaceAll("\\", "/"), ".grok/hooks/ai-umpire.json");
    assert.match(adapter.grokBuildStopHookFile.content, /hook-stop --tool grok-build/);
  });

  it("owns the executable Grok continuation contract", () => {
    const decoded = adapter.grokBuildContinuationAdapter.decodeEvent({ cwd: "/repo", hookEventName: "stop", sessionId: "g1", stopHookActive: false, reason: "channel_closed" });
    assert.equal(decoded.ok, true);
    assert.equal(decoded.event.sessionEnd, true);
    assert.deepEqual(adapter.grokBuildContinuationAdapter.encodeResponse({ decision: "block", prompt: "Continue." }).response, { decision: "block", reason: "Continue." });
    assert.equal(adapter.grokBuildContinuationAdapter.probe({ surface: "plugin-event", version: null }).status, "blocked");
  });
});
