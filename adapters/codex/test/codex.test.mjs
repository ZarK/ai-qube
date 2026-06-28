import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codexAdapter, codexHostProfile, probeCodexReviewCapability } from "../dist/index.js";

describe("codex adapter", () => {
  it("registers the codex adapter contract", () => {
    assert.equal(codexAdapter.id, "codex");
    assert.equal(codexAdapter.packageName, "@tjalve/qube-adapter-codex");
  });

  it("exposes the codex host profile", () => {
    assert.equal(codexHostProfile.id, "codex");
    assert.ok(codexHostProfile.commandTargets.some((target) => target.id === "codex-review-focus-agent"));
  });

  it("probes configured codex review capability", () => {
    const capability = probeCodexReviewCapability("codex review", true);
    assert.equal(capability.host, "codex");
    assert.equal(capability.independentReviewer, true);
    assert.equal(capability.promptOnly, false);
  });
});