import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { opencodeAdapter, opencodeSessionTarget } from "../dist/index.js";

describe("opencode adapter contract", () => {
  it("keeps OpenCode host behavior at the adapter boundary", () => {
    assert.equal(opencodeAdapter.id, "opencode");
    assert.ok(opencodeAdapter.owns.includes("stop-hooks"));
    assert.match(opencodeAdapter.boundary, /adapter edge/);
    assert.equal(opencodeSessionTarget("ses_123"), "opencode:ses_123");
    assert.throws(() => opencodeSessionTarget(" ses_123"), /already normalized/);
  });
});
