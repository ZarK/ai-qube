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
    assert.ok(built.args.includes("--output-schema"));
    assert.equal(built.stdin, "inspect");
    assert.deepEqual(parseCodexModelCatalog(JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }, { slug: "  " }] })), ["gpt-5.6-luna"]);
  });
});