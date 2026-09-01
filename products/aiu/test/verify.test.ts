import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AIU_HOSTS, getDefaultAiuConfig, type AiuConfig, type AiuHost } from "../dist/src/config.js";
import { createAiuTrustedStateFingerprint, readAiuHostActivation, resolveAiuContinuationPaths } from "../dist/src/continuation_store.js";
import {
  activationMatchesCurrentConfiguration,
  assertVerificationPath,
  createAiuManagedAssetDigest,
  createAiuRelevantConfigDigest,
  runAiuVerify,
  type AiuPreparedVerification,
  type AiuVerificationDiscovery,
  type AiuVerificationRuntime,
  type AiuVerificationScenario,
} from "../dist/src/verify.js";

const digest = "a".repeat(64);

describe("native continuation verification", () => {
  it("produces one stable successful result for every registered adapter", async () => {
    for (const host of AIU_HOSTS) {
      const repo = await createRepo(host);
      const runtime = passingRuntime(host);
      try {
        const warnings: string[] = [];
        const report = await runAiuVerify({ tool: host, cwd: repo, runtime, observedAt: "2026-09-01T12:00:00.000Z", onWarning: (warning) => warnings.push(warning) });
        assert.equal(report.status, "passed", host);
        assert.equal(report.reasonCode, "verification-passed", host);
        assert.deepEqual(report.scenarios.map((scenario) => [scenario.kind, scenario.status]), [["allow", "passed"], ["continue", "passed"]]);
        assert.equal(report.workspace?.disposable, true);
        assert.equal(report.workspace?.packed, true);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /can use a model or incur cost/);
        const evidence = readAiuHostActivation(resolveAiuContinuationPaths(repo, getDefaultAiuConfig()), host);
        assert.equal(evidence?.schemaVersion, 2);
        assert.equal(evidence?.eventState, "consumed");
        assert.equal(evidence?.sessionId, `${host}-session`);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  });

  it("returns precise blocked results before launch", async () => {
    const repo = await createRepo("codex");
    try {
      for (const reasonCode of ["missing-executable", "unsupported-version", "authentication-missing", "trust-prerequisite-unmet", "model-unavailable", "packed-artifact-required"] as const) {
        let prepared = false;
        const runtime = passingRuntime("codex", {
          discover: reasonCode === "packed-artifact-required" ? undefined : () => ({ status: "blocked", reasonCode, nextAction: `Resolve ${reasonCode}.` }),
          prepare: reasonCode === "packed-artifact-required" ? () => { prepared = true; return { status: "blocked", reasonCode, nextAction: "Use a packed artifact." }; } : undefined,
          onPrepare: () => { prepared = true; },
        });
        const report = await runAiuVerify({ tool: "codex", cwd: repo, runtime });
        assert.equal(report.status, "blocked");
        assert.equal(report.reasonCode, reasonCode);
        assert.equal(prepared, reasonCode === "packed-artifact-required");
        assert.deepEqual(report.scenarios, []);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects hook-only evidence, invalid responses, timeouts, aborts, and allow-path continuation", async () => {
    const repo = await createRepo("codex");
    try {
      const cases: readonly [AiuVerificationScenario, string][] = [
        [scenario("continue", "continuation-not-consumed", { nativeInvocationObserved: true }), "continuation-not-consumed"],
        [scenario("continue", "next-turn-not-observed", { nativeInvocationObserved: true, responseConsumed: true }), "next-turn-not-observed"],
        [scenario("continue", "native-response-invalid"), "native-response-invalid"],
        [scenario("continue", "native-timeout"), "native-timeout"],
        [{ ...scenario("continue", "user-aborted"), status: "aborted" }, "user-aborted"],
      ];
      for (const [failure, reason] of cases) {
        const report = await runAiuVerify({ tool: "codex", cwd: repo, runtime: passingRuntime("codex", { continueScenario: failure }) });
        assert.notEqual(report.status, "passed");
        assert.equal(report.reasonCode, reason);
      }
      const allowFailure = { ...scenario("allow", "allow-path-continued"), nativeInvocationObserved: true, continuationCount: 1 } as const;
      const report = await runAiuVerify({ tool: "codex", cwd: repo, runtime: passingRuntime("codex", { allowScenario: allowFailure }) });
      assert.equal(report.reasonCode, "allow-path-continued");
      assert.equal(report.scenarios.length, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("invalidates evidence across config, surface, asset, trust, and harness identity changes", async () => {
    const repo = await createRepo("codex");
    try {
      const config = getDefaultAiuConfig();
      const activation = {
        schemaVersion: 2 as const,
        contractVersion: 1 as const,
        host: "codex" as const,
        delivery: "stdout" as const,
        event: "stop-hook" as const,
        eventState: "consumed" as const,
        harnessVersion: "0.147.0",
        surface: "stop-hook",
        packedArtifactDigest: digest,
        managedAssetDigest: createAiuManagedAssetDigest("codex", repo),
        relevantConfigDigest: createAiuRelevantConfigDigest(config, "codex"),
        trustedStateFingerprint: createAiuTrustedStateFingerprint(config.trustedStateCommands),
        observedAt: "2026-09-01T12:00:00.000Z",
      };
      assert.equal(activationMatchesCurrentConfiguration({ activation, config, repoRoot: repo, harnessVersion: "0.147.0" }), true);
      assert.equal(activationMatchesCurrentConfiguration({ activation: { ...activation, surface: "other" }, config, repoRoot: repo, harnessVersion: "0.147.0" }), false);
      assert.equal(activationMatchesCurrentConfiguration({ activation: { ...activation, managedAssetDigest: digest }, config, repoRoot: repo, harnessVersion: "0.147.0" }), false);
      assert.equal(activationMatchesCurrentConfiguration({ activation: { ...activation, trustedStateFingerprint: digest }, config, repoRoot: repo, harnessVersion: "0.147.0" }), false);
      assert.equal(activationMatchesCurrentConfiguration({ activation, config: { ...config, cooldowns: { promptMs: 2 } }, repoRoot: repo, harnessVersion: "0.147.0" }), false);
      assert.equal(activationMatchesCurrentConfiguration({ activation, config, repoRoot: repo, harnessVersion: "0.148.0" }), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects absolute, parent-relative, and linked verification paths", async (t) => {
    const repo = await createRepo("codex");
    try {
      assert.throws(() => assertVerificationPath(repo, path.resolve(repo, "outside")), /repository-relative/);
      assert.throws(() => assertVerificationPath(repo, "../outside"), /repository-relative/);
      const target = path.join(repo, "target");
      const link = path.join(repo, "link");
      await mkdir(target);
      try {
        const { symlink } = await import("node:fs/promises");
        await symlink(target, link, "junction");
        assert.throws(() => assertVerificationPath(repo, "link"), /symbolic links/);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") t.diagnostic("Link creation is unavailable on this platform.");
        else throw error;
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("runs a bounded real-harness smoke only when explicitly enabled", { skip: process.env.AIU_REAL_HARNESS_VERIFY !== "1" }, async () => {
    const tool = (process.env.AIU_REAL_HARNESS_TOOL ?? "opencode") as AiuHost;
    assert.ok(AIU_HOSTS.includes(tool));
    const report = await runAiuVerify({ tool, timeoutMs: 180_000 });
    assert.equal(report.status, "passed", JSON.stringify(report));
  });
});

async function createRepo(host: AiuHost): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aiu-verify-test-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".qube", "aiu"), { recursive: true });
  const config: AiuConfig = { ...getDefaultAiuConfig(), hosts: { ...getDefaultAiuConfig().hosts, enabled: [host] } };
  await writeFile(path.join(root, ".qube", "aiu", "config.json"), `${JSON.stringify(config)}\n`, "utf8");
  return root;
}

function passingRuntime(host: AiuHost, options: {
  readonly discover?: AiuVerificationRuntime["discover"];
  readonly prepare?: AiuVerificationRuntime["prepare"];
  readonly onPrepare?: () => void;
  readonly allowScenario?: AiuVerificationScenario;
  readonly continueScenario?: AiuVerificationScenario;
} = {}): AiuVerificationRuntime {
  const discovery: AiuVerificationDiscovery = { executablePath: `${host}.exe`, executableIdentity: `${host}.exe`, harnessVersion: host === "codex" ? "0.147.0" : "1.18.25", surface: host === "opencode" ? "plugin-event" : "stop-hook", authentication: "ready", repositoryTrust: "required", model: host === "opencode" ? "opencode/test-free" : null };
  const workspace: AiuPreparedVerification = { root: path.join(tmpdir(), `aiu-runtime-${host}`), aiuEntry: "packed/bin/run", modePath: "mode", markerPath: "marker", tokenPath: "token", commandPath: "command", packedArtifactDigest: digest, managedAssetDigest: digest, relevantConfigDigest: digest, trustedStateFingerprint: digest, config: getDefaultAiuConfig() };
  return {
    discover: options.discover ?? (() => discovery),
    prepare: options.prepare ?? (() => { options.onPrepare?.(); return workspace; }),
    runScenario({ kind }) {
      return kind === "allow"
        ? options.allowScenario ?? { kind: "allow", status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: false, nextTurnObserved: false, continuationCount: 0 }
        : options.continueScenario ?? { kind: "continue", status: "passed", reasonCode: "verification-passed", nativeInvocationObserved: true, responseConsumed: true, nextTurnObserved: true, continuationCount: 1, sessionId: `${host}-session` };
    },
    cleanup() {},
  };
}

function scenario(kind: "continue" | "allow", reasonCode: AiuVerificationScenario["reasonCode"], overrides: Partial<AiuVerificationScenario> = {}): AiuVerificationScenario {
  return { kind, status: "failed", reasonCode, nativeInvocationObserved: false, responseConsumed: false, nextTurnObserved: false, continuationCount: 0, ...overrides };
}
