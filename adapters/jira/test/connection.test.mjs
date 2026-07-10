import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { jiraAdapter, probeJiraConnection } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/connection-pass.json", import.meta.url), "utf8"));

describe("Jira connection probe", () => {
  it("passes offline from the recorded /myself fixture", async () => {
    assert.equal(jiraAdapter.connection.authMethod, "basic-env");
    const result = await probeJiraConnection({ mode: "fixture", env: { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture-token" }, config: { baseUrl: "https://fixture.atlassian.net" }, fixture });
    assert.equal(result.status, "pass");
    assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  });

  it("reports an explicit unverified status when offline", async () => {
    assert.equal((await probeJiraConnection({ mode: "offline" })).status, "unverified");
  });

  it("runs the live read-only probe only when explicitly enabled", { skip: process.env.QUBE_LIVE_PROBES !== "1" }, async () => {
    assert.equal((await probeJiraConnection({ mode: "live" })).status, "pass");
  });
});
