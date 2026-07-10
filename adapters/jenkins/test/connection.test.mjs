import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { jenkinsAdapter, probeJenkinsConnection } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/connection-pass.json", import.meta.url), "utf8"));

describe("Jenkins connection probe", () => {
  it("passes offline from the recorded whoAmI fixture", async () => {
    assert.equal(jenkinsAdapter.connection.authMethod, "token-env");
    const result = await probeJenkinsConnection({ mode: "fixture", env: { JENKINS_API_TOKEN: "fixture-token" }, config: { baseUrl: "https://jenkins.example.com", user: "fixture-user" }, fixture });
    assert.equal(result.status, "pass");
    assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  });

  it("reports an explicit unverified status when offline", async () => {
    assert.equal((await probeJenkinsConnection({ mode: "offline" })).status, "unverified");
  });

  it("runs the live read-only probe only when explicitly enabled", { skip: process.env.QUBE_LIVE_PROBES !== "1" }, async () => {
    assert.equal((await probeJenkinsConnection({ mode: "live" })).status, "pass");
  });
});
