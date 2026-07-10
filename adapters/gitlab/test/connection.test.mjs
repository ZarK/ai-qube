import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { gitLabAdapter, probeGitLabConnection } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/connection-pass.json", import.meta.url), "utf8"));

describe("GitLab connection probe", () => {
  it("passes offline from the recorded /user fixture", async () => {
    assert.equal(gitLabAdapter.connection.authMethod, "token-env");
    const result = await probeGitLabConnection({ mode: "fixture", env: { GITLAB_TOKEN: "fixture-token" }, config: { projectId: "group/project" }, fixture });
    assert.equal(result.status, "pass");
    assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  });

  it("reports an explicit unverified status when offline", async () => {
    assert.equal((await probeGitLabConnection({ mode: "offline" })).status, "unverified");
  });

  it("runs the live read-only probe only when explicitly enabled", { skip: process.env.QUBE_LIVE_PROBES !== "1" }, async () => {
    assert.equal((await probeGitLabConnection({ mode: "live" })).status, "pass");
  });
});
