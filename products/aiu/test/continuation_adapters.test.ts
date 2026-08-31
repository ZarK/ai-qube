import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AIU_CONTINUATION_HOSTS,
  decodeAiuContinuationEvent,
  getAiuContinuationAdapter,
} from "../dist/src/continuation_adapters.js";

describe("AI Umpire continuation adapter registry", () => {
  it("derives exactly four runtime hosts from executable adapter registrations", () => {
    assert.deepEqual(AIU_CONTINUATION_HOSTS, ["opencode", "codex", "claude-code", "grok-build"]);
    assert.equal(AIU_CONTINUATION_HOSTS.includes("cursor" as never), false);
    for (const host of AIU_CONTINUATION_HOSTS) {
      const adapter = getAiuContinuationAdapter(host);
      assert.equal(adapter.declaration.hostId, host);
      assert.equal(JSON.stringify(adapter.declaration).includes("function"), false);
      assert.equal(typeof adapter.decodeEvent, "function");
      assert.equal(typeof adapter.encodeResponse, "function");
    }
    for (const host of ["codex", "claude-code", "grok-build"] as const) {
      const declaration = getAiuContinuationAdapter(host).declaration;
      assert.equal(declaration.delivery.method, "stdout-json", host);
      assert.equal(declaration.delivery.sessionScope, "current-session", host);
      assert.equal(declaration.umpireModes.includes("wait"), false, host);
      assert.equal(Object.hasOwn(declaration, "sessionResume"), false, host);
      assert.equal(Object.hasOwn(declaration, "processRestart"), false, host);
    }
  });

  it("rejects an incompatible native surface before decoding its event", () => {
    const rejected = decodeAiuContinuationEvent("opencode", {
      surface: "stop-hook",
      version: null,
      event: { type: "session.idle", payload: { sessionId: "s1" } },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "unsupported-event");
    assert.match(rejected.error, /Unsupported continuation surface/);
  });
});
