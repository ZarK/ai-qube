import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as core from "../dist/index.js";

const observedAt = "2026-08-31T12:00:00.000Z";

function fact(id, state) {
  return Object.freeze({
    id,
    state,
    reasonCode: `${id}-${state}`,
    reason: `${id} is ${state}.`,
    observedAt,
    nextAction: state === "ready" || state === "not-required" ? "No action is required." : `Inspect ${id}.`,
  });
}

function report(host, state = "ready") {
  return core.defineAgentHostReadinessReport({
    version: core.AGENT_HOST_READINESS_VERSION,
    host,
    facts: Object.freeze(Object.fromEntries(core.AGENT_HOST_READINESS_FACT_IDS.map((id) => [id, fact(id, state)]))),
  });
}

describe("canonical agent host capability profiles", () => {
  it("covers all five hosts, all surfaces, and every explicit capability dimension", () => {
    assert.deepEqual(Object.keys(core.AGENT_HOST_CAPABILITY_PROFILES), [...core.AGENT_HOST_IDS]);
    for (const host of core.AGENT_HOST_IDS) {
      const profile = core.AGENT_HOST_CAPABILITY_PROFILES[host];
      assert.equal(profile.version, 1, host);
      assert.deepEqual(Object.keys(profile.surfaces), [...core.AGENT_HOST_SURFACES], host);
      assert.deepEqual(Object.keys(profile.capabilities), [...core.AGENT_HOST_CAPABILITY_IDS], host);
      assert.equal(JSON.stringify(profile).includes("listModels"), false, host);
      assert.equal(JSON.stringify(profile).includes("function"), false, host);
      for (const capability of Object.values(profile.capabilities)) {
        assert.equal(capability.minimumVersion, null, `${host}/${capability.id}`);
        assert.ok(capability.description.length > 0, `${host}/${capability.id}`);
        assert.ok(capability.nextAction.length > 0, `${host}/${capability.id}`);
        assert.equal(capability.support === "unsupported", capability.unavailableReason !== null, `${host}/${capability.id}`);
      }
    }
  });

  it("preserves the previous task, subagent, review, model-catalog, and continuation support levels", () => {
    const rows = {
      opencode: ["supported", "supported", "supported", "unsupported", "supported", "supported"],
      codex: ["supported", "supported", "supported", "supported", "supported", "experimental"],
      "claude-code": ["supported", "supported", "supported", "unsupported", "unsupported", "experimental"],
      "grok-build": ["unsupported", "supported", "supported", "supported", "supported", "experimental"],
      cursor: ["unsupported", "unsupported", "unsupported", "supported", "supported", "unsupported"],
    };
    for (const [host, expected] of Object.entries(rows)) {
      const capabilities = core.AGENT_HOST_CAPABILITY_PROFILES[host].capabilities;
      const continuation = capabilities["continuation-selected-session-delivery"].support !== "unsupported"
        ? capabilities["continuation-selected-session-delivery"].support
        : capabilities["continuation-stop-hook"].support;
      assert.deepEqual([
        capabilities["task-write"].support,
        capabilities["subagent-invoke"].support,
        capabilities["review-host-guided"].support,
        capabilities["review-isolated"].support,
        capabilities["model-catalog"].support,
        continuation,
      ], expected, host);
    }
  });

  it("rejects invalid versions, missing dimensions, impossible surfaces, and functions", () => {
    const source = structuredClone(core.AGENT_HOST_CAPABILITY_PROFILES.opencode);
    assert.throws(() => core.defineAgentHostCapabilityProfile({ ...source, version: 2 }), /Regenerate the profile with version 1/);
    const missing = structuredClone(source);
    delete missing.capabilities["task-read"];
    assert.throws(() => core.defineAgentHostCapabilityProfile(missing), /missing capability "task-read"/);
    const impossible = structuredClone(source);
    impossible.capabilities["task-read"].surfaces = [];
    assert.throws(() => core.defineAgentHostCapabilityProfile(impossible), /requires an applicable surface/);
    const executable = structuredClone(source);
    executable.capabilities["task-read"].probe = () => true;
    assert.throws(() => core.defineAgentHostCapabilityProfile(executable), /cannot contain executable functions/);
  });
});

describe("agent host runtime readiness", () => {
  it("accepts every state and requires every fact with safe observation metadata", () => {
    const states = core.AGENT_HOST_READINESS_STATES;
    const facts = Object.fromEntries(core.AGENT_HOST_READINESS_FACT_IDS.map((id, index) => [id, fact(id, states[index % states.length])]));
    const value = core.defineAgentHostReadinessReport({ version: 1, host: "codex", facts });
    assert.deepEqual(new Set(Object.values(value.facts).map((entry) => entry.state)), new Set(states));

    const missing = structuredClone(value);
    delete missing.facts.authentication;
    assert.throws(() => core.defineAgentHostReadinessReport(missing), /missing fact "authentication"/);
    const unsafe = structuredClone(value);
    unsafe.facts.authentication.reason = "token=do-not-publish";
    assert.throws(() => core.defineAgentHostReadinessReport(unsafe), /unsafe probe output/);
  });

  it("does not treat PATH presence, unknown authentication, or unknown trust as ready", () => {
    const value = report("opencode", "unknown");
    const result = core.evaluateAgentHostCommandReadiness(core.AGENT_HOST_COMMAND_REQUIREMENTS["models-list"], core.AGENT_HOST_CAPABILITY_PROFILES.opencode, value);
    assert.equal(result.ready, false);
    assert.ok(result.blockingFacts.includes("authentication"));
  });

  it("blocks only commands that select unavailable optional capabilities", () => {
    const value = report("cursor");
    const profile = core.AGENT_HOST_CAPABILITY_PROFILES.cursor;
    for (const command of ["help", "version", "queue", "view", "status"]) {
      const requirement = core.AGENT_HOST_COMMAND_REQUIREMENTS[command];
      assert.deepEqual(requirement.readinessFacts, [], command);
      assert.equal(core.evaluateAgentHostCommandReadiness(requirement, profile).ready, true, command);
    }
    assert.throws(() => core.commandRequirement("undeclared-command"), /Unknown agent host command requirement/);
    const continuation = core.evaluateAgentHostCommandReadiness(core.AGENT_HOST_COMMAND_REQUIREMENTS["continuation-stop-hook"], profile, value);
    assert.equal(continuation.ready, false);
    assert.deepEqual(continuation.missingCapabilities, ["continuation-stop-hook"]);
    const openCodeContinuation = core.evaluateAgentHostCommandReadiness(
      core.AGENT_HOST_COMMAND_REQUIREMENTS["continuation-selected-session"],
      core.AGENT_HOST_CAPABILITY_PROFILES.opencode,
      report("opencode"),
    );
    assert.equal(openCodeContinuation.ready, true);
  });

  it("enforces bounded allowlisted adapter probes", async () => {
    await assert.rejects(() => core.runBoundedAgentHostReadinessProbe({
      id: "undeclared",
      facts: ["adapter"],
      timeoutMs: 100,
      maxOutputBytes: 1024,
      run: async () => [fact("authentication", "unknown")],
    }), /undeclared fact/);
    await assert.rejects(() => core.runBoundedAgentHostReadinessProbe({
      id: "oversized",
      facts: ["adapter"],
      timeoutMs: 100,
      maxOutputBytes: 10,
      run: async () => [fact("adapter", "ready")],
    }), /exceeded its output bound/);
    await assert.rejects(() => core.runBoundedAgentHostReadinessProbe({
      id: "duplicate",
      facts: ["adapter"],
      timeoutMs: 100,
      maxOutputBytes: 1024,
      run: async () => [fact("adapter", "ready"), fact("adapter", "ready")],
    }), /duplicate fact/);
  });
});
