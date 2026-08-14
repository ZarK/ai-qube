import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QubeAdapterContract } from "@tjalve/qube-core";

import { LIVE_COMBINATION_ARCHETYPES, type LiveCombinationArchetype } from "./archetypes.js";
import {
  evaluateLiveGate,
  isLiveSuiteProvider,
  runProvisionerLifecycle,
  type LiveSuiteContext,
  type LiveSuiteProvider,
  type LiveSuiteResult,
  type ProviderProvisioner,
} from "./provisioner.js";
import { LIVE_SUITE_ENV_VAR } from "./seed-manifest.js";

export interface CombinationAdapters {
  readonly [providerId: string]: QubeAdapterContract | undefined;
}

export interface CombinationSuiteOptions {
  readonly adapters: CombinationAdapters;
  readonly createProvisioner: (providerId: LiveSuiteProvider, context: LiveSuiteContext) => ProviderProvisioner;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Readonly<Record<string, Record<string, unknown>>>;
  readonly probe?: (adapter: QubeAdapterContract) => Promise<{ readonly status: "pass" | "fail" | "unverified"; readonly summary: string }>;
  readonly probeGithub?: () => Promise<{ readonly ok: boolean; readonly workIds: readonly string[] }>;
}

export async function runLiveCombination(
  archetype: LiveCombinationArchetype,
  options: CombinationSuiteOptions,
): Promise<LiveSuiteResult> {
  if (archetype.work === "jira" && (archetype.review === "jira" || archetype.ci === "jira")) {
    return combinationResult({
      status: "error",
      reason: "unsupported-provider",
      summary: "Jira cannot be selected as review or CI in a live combination.",
    });
  }
  for (const role of [archetype.work, archetype.review, archetype.ci]) {
    if (role !== "github" && !isLiveSuiteProvider(role)) {
      return combinationResult({
        status: "error",
        reason: "unsupported-provider",
        summary: `Live combination ${archetype.id} does not support provider ${role}.`,
      });
    }
  }
  if (archetype.liveProviders.length === 0) {
    const live = options.env?.[LIVE_SUITE_ENV_VAR] === "1";
    const token = options.env?.GITHUB_TOKEN ?? options.env?.GH_TOKEN;
    if (!live || !token || !options.probeGithub) {
      return combinationResult({
        status: "skipped",
        reason: live ? "no-live-credentials" : "no-live-flag",
        summary: "skipped: no live credentials for the GitHub all-in-one combination.",
      });
    }
    const probe = await options.probeGithub();
    if (!probe.ok || probe.workIds.length < 2) {
      return combinationResult({
        status: "failed",
        reason: "verify-failed",
        summary: "GitHub all-in-one live combination did not observe a work cycle.",
        verifiedWork: probe.workIds,
      });
    }
    return combinationResult({
      status: "passed",
      reason: "ok",
      summary: "GitHub all-in-one live combination observed a work cycle.",
      verifiedWork: probe.workIds,
    });
  }

  const results: LiveSuiteResult[] = [];
  for (const providerId of archetype.liveProviders) {
    const adapter = options.adapters[providerId];
    if (!adapter) {
      const live = options.env?.[LIVE_SUITE_ENV_VAR] === "1";
      return combinationResult({
        status: live ? "error" : "skipped",
        reason: live ? "unsupported-provider" : "no-live-flag",
        summary: live
          ? `Live combination ${archetype.id} is missing adapter ${providerId}.`
          : "skipped: no live credentials",
      });
    }
    if (!options.probe) {
      return combinationResult({
        status: "skipped",
        reason: "no-live-credentials",
        summary: "skipped: no live credentials",
      });
    }
    const probed = await options.probe(adapter);
    if (probed.status !== "pass") {
      return combinationResult({
        status: "failed",
        reason: probed.status === "fail" ? "probe-failed" : "probe-unverified",
        summary: probed.summary,
      });
    }
    const result = await runProvisionerLifecycle({
      adapter,
      createProvisioner: context => options.createProvisioner(providerId, context),
      probe: async () => ({
        adapterId: adapter.id,
        probeId: adapter.connection?.probe.id ?? "probe",
        status: probed.status,
        authMethod: adapter.connection?.authMethod ?? "token-env",
        summary: probed.summary,
        verifyCommand: adapter.connection?.probe.verifyCommand ?? "qube doctor --json",
        readOnly: true,
      }),
      env: options.env ?? process.env,
      config: options.config?.[providerId] ?? {},
      liveEnvVar: LIVE_SUITE_ENV_VAR,
    });
    results.push(result);
    if (result.status !== "passed") {
      return result;
    }
  }
  return combinationResult({
    status: "passed",
    reason: "ok",
    summary: `${archetype.id} constructed, verified, and deconstructed ${archetype.liveProviders.join(", ")}.`,
    residue: results.flatMap(result => result.residue),
    verifiedWork: results.flatMap(result => result.verifiedWork),
  });
}

export function runLiveCombinationSuite(options: CombinationSuiteOptions): void {
  describe("curated live provider combinations", () => {
    for (const archetype of LIVE_COMBINATION_ARCHETYPES) {
      it(`${archetype.id} skips without live credentials and never reports passed`, async () => {
        const result = await runLiveCombination(archetype, {
          ...options,
          env: {},
        });
        assert.equal(result.status, "skipped");
        assert.notEqual(result.status, "passed");
      });

      it(`${archetype.id} constructs, verifies, and deconstructs, or reports skipped`, async () => {
        const result = await runLiveCombination(archetype, options);
        if (result.status === "skipped") {
          assert.notEqual(result.status, "passed");
          return;
        }
        assert.equal(result.status, "passed", result.summary);
        assert.equal(result.residue.length, 0);
        assert.ok(result.verifiedWork.length >= 2);
      });
    }

    it("rejects Jira as CI with a loud error", async () => {
      const result = await runLiveCombination({
        id: "enterprise-split",
        work: "jira",
        review: "gitlab",
        ci: "jira",
        liveProviders: ["jira"],
      }, options);
      assert.equal(result.status, "error");
      assert.equal(result.reason, "unsupported-provider");
      assert.match(result.summary, /Jira cannot be selected as review or CI/i);
    });

    it("rejects an unknown live provider with a loud error", () => {
      const adapter = options.adapters.gitlab;
      assert.ok(adapter);
      const gate = evaluateLiveGate({
        adapter: { ...adapter, id: "github" },
        env: { [LIVE_SUITE_ENV_VAR]: "1" },
        config: {},
        liveEnvVar: LIVE_SUITE_ENV_VAR,
      });
      assert.equal(gate.status, "error");
      assert.equal(gate.reason, "unsupported-provider");
    });
  });
}

function combinationResult(input: {
  readonly status: LiveSuiteResult["status"];
  readonly reason: LiveSuiteResult["reason"];
  readonly summary: string;
  readonly residue?: LiveSuiteResult["residue"];
  readonly verifiedWork?: readonly string[];
}): LiveSuiteResult {
  return {
    status: input.status,
    reason: input.reason,
    summary: input.summary,
    providerId: "combination",
    runId: null,
    tag: null,
    requestCount: 0,
    residue: Object.freeze(input.residue ?? []),
    verifiedWork: Object.freeze(input.verifiedWork ?? []),
  };
}
