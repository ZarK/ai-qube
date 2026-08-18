import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  codexAdapter,
  codexHostProfile,
  isolatedReviewHostAdapter,
  parseCodexModelCatalog,
  probeCodexReviewCapability,
} from "../dist/index.js";

describe("codex adapter", () => {
  it("registers the codex adapter contract", () => {
    assert.equal(codexAdapter.id, "codex");
    assert.equal(codexAdapter.packageName, "@tjalve/qube-adapter-codex");
  });

  it("exposes the codex host profile", () => {
    assert.equal(codexHostProfile.id, "codex");
    assert.ok(codexHostProfile.commandTargets.some((target) => target.id === "codex-review-focus-agent"));
    assert.ok(codexHostProfile.commandTargets.some((target) => target.id === "codex-make-it-so"));
  });

  it("probes configured codex review capability", () => {
    const capability = probeCodexReviewCapability("codex review", true);
    assert.equal(capability.host, "codex");
    assert.equal(capability.independentReviewer, true);
    assert.equal(capability.promptOnly, false);
  });

  it("exports the isolated-review runner", () => {
    assert.equal(isolatedReviewHostAdapter.id, "codex");
    assert.deepEqual([...isolatedReviewHostAdapter.executableNames], ["codex"]);
    assert.equal(isolatedReviewHostAdapter.windowsShell, "powershell");
    const built = isolatedReviewHostAdapter.buildInvocation({
      repoRoot: "/repo",
      model: "gpt-5.6-luna",
      effort: "high",
      maxTurns: 8,
      prompt: "inspect",
      promptPath: null,
      schemaPath: "/repo/.git/qube/schema.json",
      schemaJson: "{}",
    }, "codex");
    assert.ok(built.args.includes("--ignore-user-config"));
    assert.ok(built.args.includes("--ignore-rules"));
    assert.ok(built.args.includes("--output-schema"));
    assert.ok(built.args.includes("read-only"));
    assert.ok(built.args.includes("--strict-config"));
    assert.ok(built.args.includes("shell_environment_policy.inherit=all"));
    assert.equal(built.args.includes("--approve-for-me"), false, "--approve-for-me cannot be combined with --sandbox");
    assert.equal(built.args.includes('sandbox_permissions=["disk-full-read-access"]'), false);
    assert.equal(
      built.args.includes('windows.sandbox="unelevated"'),
      process.platform === "win32",
      "Windows isolated review must enable the unelevated sandbox backend after --ignore-user-config",
    );
    assert.equal(built.stdin, "inspect");
    assert.deepEqual(parseCodexModelCatalog(JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }, { slug: "  " }] })), ["gpt-5.6-luna"]);
  });

  it("keeps progress messages separate from the terminal response", () => {
    const progress = JSON.stringify({ status: "pending" });
    const terminal = JSON.stringify({ status: "passed" });
    const parsed = isolatedReviewHostAdapter.parseEnvelope([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: progress } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: terminal } }),
    ].join("\n"));

    assert.equal(parsed.text, terminal);
    assert.deepEqual(parsed.priorTexts, [progress]);
    assert.equal(parsed.sessionId, "thread-1");
  });
});
