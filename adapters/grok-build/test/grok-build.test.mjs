import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const adapter = require("../dist/index.js");

describe("grok-build adapter", () => {
  it("depends only on core and exports the host contracts", () => {
    const manifest = require("../package.json");
    assert.deepEqual(Object.keys(manifest.dependencies), ["@tjalve/qube-core"]);
    assert.equal(adapter.isolatedReviewHostAdapter.id, "grok-build");
    assert.equal(adapter.grokBuildRouteRunnerPath.replaceAll("\\", "/"), ".grok/agents/qube-route-runner.md");
    assert.deepEqual([...adapter.isolatedReviewHostAdapter.executableNames], ["grok"]);
    assert.equal(adapter.grokBuildHostProfile.id, "grok-build");
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
    assert.ok(adapter.grokBuildHostFiles.some((file) => file.kind === "hook"));
  });
});
