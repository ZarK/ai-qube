import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { linearAdapter, probeLinearConnection } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/connection-pass.json", import.meta.url), "utf8"));

describe("Linear connection probe", () => {
  it("passes offline from the recorded viewer fixture", async () => {
    assert.equal(linearAdapter.connection.authMethod, "token-env");
    const result = await probeLinearConnection({ mode: "fixture", env: { LINEAR_API_KEY: "fixture-key" }, config: { teamId: "fixture-team" }, fixture });
    assert.equal(result.status, "pass");
    assert.doesNotMatch(JSON.stringify(result), /fixture-key/);
  });

  it("reports an explicit unverified status when offline", async () => {
    assert.equal((await probeLinearConnection({ mode: "offline" })).status, "unverified");
  });

  it("runs the live read-only probe only when explicitly enabled", { skip: process.env.QUBE_LIVE_PROBES !== "1" }, async () => {
    assert.equal((await probeLinearConnection({ mode: "live" })).status, "pass");
  });
});
