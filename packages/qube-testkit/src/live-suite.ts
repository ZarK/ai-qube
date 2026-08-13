import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConnectionContract } from "@tjalve/qube-core";

import { LIVE_SUITE_ENV_VAR } from "./seed-manifest.js";
import {
  evaluateLiveGate,
  runProvisionerLifecycle,
  type LiveSuiteOptions,
  type LiveSuiteResult,
} from "./provisioner.js";

export function runLiveProvisionerSuite(options: LiveSuiteOptions): void {
  const adapterId = options.adapter.id;
  describe(`${adapterId} live provisioner`, () => {
    it("skips without credentials and never reports passed", async () => {
      const result = await runProvisionerLifecycle({
        ...options,
        env: {},
        config: {},
      });
      assertSkipped(result);
    });

    it("skips when the live flag is set but credentials are missing", async () => {
      const result = await runProvisionerLifecycle({
        ...options,
        env: { [LIVE_SUITE_ENV_VAR]: "1" },
        config: {},
        liveEnvVar: LIVE_SUITE_ENV_VAR,
      });
      assertSkipped(result);
      assert.equal(result.reason, "no-live-credentials");
    });

    it("skips without the live flag even when credentials are present", async () => {
      const result = await runProvisionerLifecycle({
        ...options,
        env: credentialEnv(options.adapter.connection),
        config: requiredConfig(options.adapter.connection),
        liveEnvVar: LIVE_SUITE_ENV_VAR,
      });
      assertSkipped(result);
      assert.equal(result.reason, "no-live-flag");
    });

    it("does not report passed when the connection probe fails", async () => {
      const result = await runProvisionerLifecycle({
        ...options,
        env: { ...credentialEnv(options.adapter.connection), [LIVE_SUITE_ENV_VAR]: "1" },
        config: requiredConfig(options.adapter.connection),
        probe: async () => ({
          adapterId,
          probeId: options.adapter.connection?.probe.id ?? "probe",
          status: "fail",
          authMethod: options.adapter.connection?.authMethod ?? "token-env",
          summary: "Read-only connection probe failed.",
          verifyCommand: options.adapter.connection?.probe.verifyCommand ?? "qube doctor --json",
          readOnly: true,
        }),
      });
      assert.notEqual(result.status, "passed");
      assert.equal(result.status, "failed");
      assert.equal(result.reason, "probe-failed");
    });

    it("rejects an unsupported provider with a loud error", () => {
      const gate = evaluateLiveGate({
        adapter: { ...options.adapter, id: "jira" },
        env: { [LIVE_SUITE_ENV_VAR]: "1" },
        config: {},
        liveEnvVar: LIVE_SUITE_ENV_VAR,
      });
      assert.equal(gate.status, "error");
      assert.equal(gate.reason, "unsupported-provider");
      assert.match(gate.summary, /does not support provider jira/);
    });

    it("rejects an unsupported auth mode with a loud error", () => {
      const connection = options.adapter.connection;
      assert.ok(connection, "Live suite adapter must declare a connection contract.");
      const gate = evaluateLiveGate({
        adapter: {
          ...options.adapter,
          connection: { ...connection, authMethod: "cli-delegated" },
        },
        env: { [LIVE_SUITE_ENV_VAR]: "1" },
        config: requiredConfig(connection),
        liveEnvVar: LIVE_SUITE_ENV_VAR,
      });
      assert.equal(gate.status, "error");
      assert.equal(gate.reason, "unsupported-auth-mode");
      assert.match(gate.summary, /token-env/);
    });

    it("constructs, verifies, and deconstructs with zero residue, or reports skipped", async () => {
      const result = await runProvisionerLifecycle({
        ...options,
        env: options.env ?? process.env,
        config: options.config ?? {},
      });
      if (result.status === "skipped") {
        assertSkipped(result);
        return;
      }
      assert.equal(result.status, "passed", result.summary);
      assert.equal(result.reason, "ok");
      assert.equal(result.residue.length, 0);
      assert.ok(result.verifiedWork.length >= 2, "Live verify must observe the shared seed work items.");
    });
  });
}

function assertSkipped(result: LiveSuiteResult): void {
  assert.equal(result.status, "skipped");
  assert.notEqual(result.status, "passed");
  assert.match(result.summary, /skipped: no live credentials/);
  assert.equal(result.residue.length, 0);
}

function credentialEnv(contract: ConnectionContract | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const variable of contract?.envVars ?? []) env[variable.name] = "fixture-credential";
  for (const field of contract?.configFields ?? []) {
    if (field.envFallback) env[field.envFallback] = "fixture-config";
  }
  return env;
}

function requiredConfig(contract: ConnectionContract | undefined): Record<string, string> {
  const config: Record<string, string> = {};
  for (const field of contract?.configFields ?? []) {
    if (field.required) config[field.name] = field.defaultValue ?? "fixture-config";
  }
  return config;
}
