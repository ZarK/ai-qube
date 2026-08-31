import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { opencodeContinuationAdapter, opencodeHostProfile, parseOpenCodeModelCatalog } from "../dist/index.js";

describe("opencode adapter", () => {
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
    assert.equal(opencodeHostProfile.review.isolated.support, "unsupported");
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
    const encoded = opencodeContinuationAdapter.encodeResponse({ decision: "deliver", sessionId: "s1", cwd: "/repo" });
    assert.equal(encoded.ok, true);
    assert.deepEqual(encoded.response, { path: { id: "s1" }, body: { command: "make-it-so", arguments: "" }, query: { directory: "/repo" } });
    assert.equal(opencodeContinuationAdapter.encodeResponse({ decision: "deliver", sessionId: "s1" }).ok, false);
    const assets = opencodeContinuationAdapter.renderManagedAssets({ packageVersions: { "@tjalve/aiu": "1.2.3" } });
    assert.equal(assets.length, 2);
    assert.match(assets.find((asset) => asset.id === "package-dependency").content, /"@tjalve\/aiu": "1.2.3"/);
  });
});
