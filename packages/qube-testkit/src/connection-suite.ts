import assert from "node:assert/strict";

import type { QubeAdapterContract } from "@tjalve/qube-core";

import { assertNoSecretMaterial } from "./fixtures.js";
import type { ConnectionHarness } from "./types.js";

export async function verifyConnection(adapter: QubeAdapterContract, harness: ConnectionHarness): Promise<void> {
  assert.equal(harness.contract.adapterId, adapter.id);
  assert.deepEqual(harness.contract, adapter.connection);
  assert.equal(harness.contract.probe.readOnly, true);
  const result = await harness.probe({ mode: "fixture", fixture: harness.fixture });
  assert.equal(result.status, "pass");
  assert.equal(result.adapterId, adapter.id);
  assert.equal(result.probeId, harness.contract.probe.id);
  assert.equal(result.readOnly, true);

  // Always exercise the three negative trust-boundary outcomes when a connection suite is present.
  const bad = await harness.probe({
    mode: "fixture",
    fixture: harness.negativeFixtures?.badCredential ?? {
      command: { exitCode: 1, stdout: "", stderr: "authentication failed" },
    },
  });
  assert.equal(bad.status, "fail", "Bad-credential connection fixture must fail.");
  assertNoSecretMaterial(bad.summary, "bad-credential probe summary");

  const unreachable = await harness.probe({
    mode: "fixture",
    fixture: harness.negativeFixtures?.unreachable ?? { error: "network" },
  });
  assert.notEqual(unreachable.status, "pass", "Unreachable connection fixture must not pass.");
  assertNoSecretMaterial(unreachable.summary, "unreachable probe summary");

  const timeout = await harness.probe({
    mode: "fixture",
    fixture: harness.negativeFixtures?.timeout ?? { error: "timeout" },
  });
  assert.equal(timeout.status, "fail", "Timeout connection fixture must fail.");
  assert.match(timeout.summary, /timed out/i);
  assertNoSecretMaterial(timeout.summary, "timeout probe summary");
  assertNoSecretMaterial(result.summary, "passing probe summary");
}
