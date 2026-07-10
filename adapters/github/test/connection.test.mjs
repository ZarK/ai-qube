import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { githubAdapter, probeGitHubConnection } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/connection-pass.json", import.meta.url), "utf8"));

describe("GitHub connection probe", () => {
  it("passes offline from the recorded gh auth fixture", async () => {
    assert.equal(githubAdapter.connection.authMethod, "cli-delegated");
    const result = await probeGitHubConnection({ mode: "fixture", fixture });
    assert.equal(result.status, "pass");
    assert.equal(result.readOnly, true);
  });

  it("reports an explicit unverified status when offline", async () => {
    assert.equal((await probeGitHubConnection({ mode: "offline" })).status, "unverified");
  });

  it("runs the live read-only probe only when explicitly enabled", { skip: process.env.QUBE_LIVE_PROBES !== "1" }, async () => {
    assert.equal((await probeGitHubConnection({ mode: "live" })).status, "pass");
  });
});
