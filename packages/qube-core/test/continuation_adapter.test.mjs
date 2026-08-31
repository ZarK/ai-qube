import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as core from "../dist/index.js";

function declaration(overrides = {}) {
  return {
    version: core.CONTINUATION_DECLARATION_VERSION,
    hostId: "opencode",
    nativeSurfaces: [{ id: "plugin-event", minimumVersion: "1.2.0", maximumVersionExclusive: "2.0.0" }],
    triggerEvents: ["session.idle"],
    delivery: { method: "host-command", sessionScope: "selected-session" },
    umpireModes: ["continue", "repair", "wait", "stop"],
    trust: { repositoryRequired: true, description: "Trust the repository plugin." },
    managedAssets: [{ id: "plugin", relativePath: ".opencode/plugins/aiu.ts", description: "Plugin.", ownership: "dedicated", role: "entrypoint" }],
    activationEvidence: { event: "plugin-event", delivery: "host", requiresSessionId: true },
    currentIssueRecovery: true,
    ...overrides,
  };
}

function adapter(hostId = "opencode") {
  const declared = core.defineContinuationDeclaration(declaration({ hostId }));
  return {
    version: core.CONTINUATION_ADAPTER_VERSION,
    declaration: declared,
    renderManagedAssets: () => [],
    validateManagedAsset: () => ({ state: "current", reason: "current" }),
    mergeManagedAsset: (_id, existing) => ({ ok: true, content: existing, changed: false, validation: { state: "current", reason: "current" } }),
    decodeEvent: () => ({ ok: false, code: "unsupported-event", error: "unsupported" }),
    encodeResponse: () => ({ ok: true, response: {} }),
    probe: (input) => core.probeContinuationSurface(declared, input),
  };
}

describe("continuation adapter contract", () => {
  it("keeps declarations JSON-safe and executable behavior separate", () => {
    const declared = core.defineContinuationDeclaration(declaration());
    assert.equal(JSON.stringify(declared).includes("function"), false);
    assert.throws(() => core.defineContinuationDeclaration(declaration({ secretLoader: () => "secret" })), /cannot contain executable/);
    assert.throws(() => core.defineContinuationDeclaration(declaration({ version: 2 })), /Unsupported continuation declaration version/);
  });

  it("rejects escaping managed paths, incomplete adapters, and duplicate registrations", () => {
    assert.throws(() => core.defineContinuationDeclaration(declaration({ managedAssets: [{ id: "escape", relativePath: "../outside", description: "Escape.", ownership: "dedicated", role: "entrypoint" }] })), /stay inside the repository/);
    assert.throws(() => core.defineContinuationDeclaration(declaration({ managedAssets: [{ id: "absolute", relativePath: "C:\\outside", description: "Absolute.", ownership: "dedicated", role: "entrypoint" }] })), /stay inside the repository/);
    assert.throws(() => core.defineContinuationAdapter({ ...adapter(), encodeResponse: undefined }), /missing executable function encodeResponse/);
    const valid = core.defineContinuationAdapter(adapter());
    assert.throws(() => core.createContinuationAdapterRegistry([valid, valid]), /Duplicate continuation adapter registration/);
    assert.throws(() => core.defineContinuationAdapter({ ...adapter(), version: 2 }), /Unsupported continuation adapter version/);
  });

  it("blocks incompatible versions and surfaces before native events run", () => {
    const valid = core.defineContinuationAdapter(adapter());
    assert.equal(valid.probe({ surface: "stop-hook", version: "1.5.0" }).status, "blocked");
    assert.equal(valid.probe({ surface: "plugin-event", version: "1.1.9" }).status, "blocked");
    assert.equal(valid.probe({ surface: "plugin-event", version: "2.0.0" }).status, "blocked");
    assert.equal(valid.probe({ surface: "plugin-event", version: "1.5.0" }).status, "ready");
  });
});
