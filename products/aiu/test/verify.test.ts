import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AIU_HOSTS, getDefaultAiuConfig, type AiuConfig, type AiuHost } from "../dist/src/config.js";
import { createAiuTrustedStateFingerprint, readAiuHostActivation, resolveAiuContinuationPaths, writeAiuContinuationState } from "../dist/src/continuation_store.js";
import { evaluateCursorVerificationLifecycle } from "../dist/src/cursor_verify.js";
import {
  activationMatchesCurrentConfiguration,
  assertVerificationPath,
  createVerificationWorkspaceRoot,
  cursorVerificationTerminalPrerequisite,
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

  it("reports the interactive Cursor terminal prerequisite before workspace setup", () => {
    const missing = cursorVerificationTerminalPrerequisite({ isTTY: false }, { isTTY: true });
    assert.equal(missing?.status, "blocked");
    assert.equal(missing?.reasonCode, "terminal-prerequisite-unmet");
    assert.match(missing?.nextAction ?? "", /standard input and standard error/);
    assert.equal(cursorVerificationTerminalPrerequisite({ isTTY: true }, { isTTY: true }), undefined);
  });

  it("awaits asynchronous scenario runtimes", async () => {
    const repo = await createRepo("codex");
    try {
      const runtime = passingRuntime("codex");
      const report = await runAiuVerify({ tool: "codex", cwd: repo, runtime: { ...runtime, async runScenario(input) { await new Promise(resolve => setTimeout(resolve, 1)); return runtime.runScenario(input); } } });
      assert.equal(report.status, "passed");
      assert.equal(report.scenarios.length, 2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("requires native Cursor allow and consumed continuation observations", async () => {
    const repo = await createRepo("cursor");
    const workspace = passingWorkspace("cursor", repo);
    const paths = resolveAiuContinuationPaths(repo, workspace.config);
    const startedAt = Date.now() - 100;
    const initial = "AIU_VERIFY_INITIAL:nonce";
    const next = "AIU_VERIFY_NEXT:nonce";
    const first = cursorObservation(0, "generation-0", [initial]);
    const second = cursorObservation(1, "generation-1", [initial, next]);
    try {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(paths.logPath, `${JSON.stringify({ event: "decision", hostId: "cursor", eventType: "stop", sessionId: "conversation", decisionKind: "stop", observedAt: new Date().toISOString() })}\n`, "utf8");
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "allow", timeoutMs: 1000, token: "nonce" }, [first], initial, next, true, startedAt)?.status, "passed");
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "allow", timeoutMs: 1000, token: "nonce" }, [first, second], initial, next, true, startedAt)?.reasonCode, "allow-path-continued");
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "continue", timeoutMs: 1000, token: "nonce" }, [first, second], initial, next, true, startedAt)?.reasonCode, "continuation-not-consumed");

      writeAiuContinuationState(paths, consumedCursorState());
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "continue", timeoutMs: 1000, token: "nonce" }, [first, second], initial, next, true, startedAt)?.status, "passed");
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "continue", timeoutMs: 1000, token: "nonce" }, [cursorObservation(0, "generation-0", ["wrong"]), second], initial, next, true, startedAt)?.reasonCode, "native-response-invalid");
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "continue", timeoutMs: 1000, token: "nonce" }, [first, second, cursorObservation(2, "generation-2", [initial, next, next])], initial, next, true, startedAt)?.reasonCode, "native-response-invalid");
      assert.equal(evaluateCursorVerificationLifecycle({ discovery: passingDiscovery("cursor"), workspace, kind: "continue", timeoutMs: 1000, token: "nonce" }, [first, { ...second, conversationId: "other" }], initial, next, true, startedAt)?.reasonCode, "native-response-invalid");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("preserves only a Cursor workspace that requires manual trust approval", async () => {
    const repo = await createRepo("cursor");
    try {
      let cursorCleanups = 0;
      const cursorRuntime = passingRuntime("cursor", {
        allowScenario: scenario("allow", "trust-prerequisite-unmet", { nativeInvocationObserved: true }),
        onCleanup: () => { cursorCleanups += 1; },
      });
      const cursorReport = await runAiuVerify({ tool: "cursor", cwd: repo, runtime: cursorRuntime });
      assert.equal(cursorReport.status, "blocked");
      assert.equal(cursorReport.reasonCode, "trust-prerequisite-unmet");
      assert.equal(cursorReport.trustApprovalPath, path.join(tmpdir(), "aiu-runtime-cursor"));
      assert.equal(cursorCleanups, 0);

      let codexCleanups = 0;
      const codexRuntime = passingRuntime("codex", {
        allowScenario: scenario("allow", "trust-prerequisite-unmet", { nativeInvocationObserved: true }),
        onCleanup: () => { codexCleanups += 1; },
      });
      const codexReport = await runAiuVerify({ tool: "codex", cwd: repo, runtime: codexRuntime });
      assert.equal(codexReport.trustApprovalPath, undefined);
      assert.equal(codexCleanups, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reuses the same controlled Cursor workspace root after manual trust", async () => {
    const repo = await createRepo("cursor");
    const root = createVerificationWorkspaceRoot("cursor", repo);
    try {
      await writeFile(path.join(root, "stale.txt"), "stale\n", "utf8");
      const reused = createVerificationWorkspaceRoot("cursor", repo);
      assert.equal(reused, root);
      await assert.rejects(readFile(path.join(root, "stale.txt"), "utf8"), { code: "ENOENT" });
      const marker = JSON.parse(await readFile(path.join(root, ".aiu-verification-workspace.json"), "utf8")) as { schemaVersion?: unknown };
      assert.equal(marker.schemaVersion, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
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

      const secret = "Bearer sk-test-1234567890abcdef";
      const redacted = await runAiuVerify({
        tool: "codex",
        cwd: repo,
        runtime: passingRuntime("codex", {
          continueScenario: scenario("continue", "continuation-not-consumed", { nativeInvocationObserved: true, diagnostic: secret }),
        }),
      });
      assert.doesNotMatch(redacted.nextAction, /sk-test/);
      assert.match(redacted.nextAction, /\[REDACTED\]/);

      const invalidResponse = await runAiuVerify({
        tool: "codex",
        cwd: repo,
        runtime: passingRuntime("codex", {
          continueScenario: scenario("continue", "native-response-invalid", { diagnostic: secret }),
        }),
      });
      assert.doesNotMatch(invalidResponse.nextAction, /sk-test/);
      assert.match(invalidResponse.nextAction, /\[REDACTED\]/);
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
  readonly onCleanup?: () => void;
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
    cleanup() { options.onCleanup?.(); },
  };
}

function scenario(kind: "continue" | "allow", reasonCode: AiuVerificationScenario["reasonCode"], overrides: Partial<AiuVerificationScenario> = {}): AiuVerificationScenario {
  return { kind, status: "failed", reasonCode, nativeInvocationObserved: false, responseConsumed: false, nextTurnObserved: false, continuationCount: 0, ...overrides };
}

function passingDiscovery(host: AiuHost): AiuVerificationDiscovery {
  return { executablePath: `${host}.exe`, executableIdentity: `${host}.exe`, harnessVersion: "2026.08.11-e8db854", surface: "stop-hook", authentication: "ready", repositoryTrust: "required", model: "test-model" };
}

function passingWorkspace(host: AiuHost, root: string): AiuPreparedVerification {
  return { root, aiuEntry: "packed/bin/run", modePath: "mode", markerPath: "marker", tokenPath: "token", commandPath: "command", packedArtifactDigest: digest, managedAssetDigest: digest, relevantConfigDigest: digest, trustedStateFingerprint: digest, config: getDefaultAiuConfig() };
}

function cursorObservation(loopCount: number, generationId: string, assistantMessages: readonly string[]) {
  return { conversationId: "conversation", generationId, cursorVersion: "2026.08.11-e8db854", status: "completed" as const, loopCount, observedAt: new Date().toISOString(), assistantMessages };
}

function consumedCursorState() {
  return {
    schemaVersion: 2 as const,
    deliveryState: "consumed" as const,
    hostId: "cursor" as const,
    eventType: "stop",
    ownerSessionId: "conversation",
    targetSessionId: "conversation",
    selectedItem: { sourceId: "verification", kind: "work-item" as const, id: "verify", title: "Verify" },
    mode: "continue" as const,
    decisionKind: "continue" as const,
    reasonCodes: ["active-work"],
    lastPromptFingerprint: "b".repeat(64),
    lastPromptAt: new Date().toISOString(),
    nativeLoopCount: 1,
    updatedAt: new Date().toISOString(),
    sourceSummaries: [],
  };
}
