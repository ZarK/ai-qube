import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getDefaultAiuConfig } from "../dist/src/config.js";
import { readAiuContinuationState, readAiuHostActivation, resolveAiuContinuationPaths } from "../dist/src/continuation_store.js";
import type * as HookStop from "../src/hook_stop.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observedAt = "2026-05-23T00:00:00.000Z";

describe("provider-neutral stop hooks", () => {
  it("blocks Codex stops with a concrete continuation prompt when policy allows it", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal(result.stderr, "");
      assert.deepEqual(result.diagnostics, []);
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Continue active work/);
      assert.equal(result.continuationDecision?.kind, "continue");
      assert.deepEqual(result.continuationDecision?.reasonCodes, ["continue-active-work"]);
      const state = readAiuContinuationState(resolveAiuContinuationPaths(target, getDefaultAiuConfig()));
      assert.equal(state?.schemaVersion, 2);
      assert.equal(state?.deliveryState, "emitted");
      assert.equal(state?.ownerSessionId, "codex-session");
      assert.equal(state?.nativeLoopCount, 1);
      const activation = readAiuHostActivation(resolveAiuContinuationPaths(target, getDefaultAiuConfig()), "codex");
      assert.equal(activation?.schemaVersion, 1);
      assert.equal(activation?.host, "codex");
      assert.equal(activation?.delivery, "stdout");
      assert.equal(activation?.event, "stop-hook");
      assert.match(activation?.trustedStateFingerprint ?? "", /^[a-f0-9]{64}$/);
      assert.equal(activation?.observedAt, observedAt);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("serializes concurrent Stop hooks and preserves the winning session owner", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const state = activeWorkState();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedCommand: [
        process.execPath,
        "-e",
        `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(state))}), 100)`,
      ],
    });
    try {
      const [first, second] = await Promise.all([
        runAiuHookStop({ tool: "codex", cwd: target, observedAt, stdin: JSON.stringify(stopPayload(target, "session-a")) }),
        runAiuHookStop({ tool: "codex", cwd: target, observedAt, stdin: JSON.stringify(stopPayload(target, "session-b")) }),
      ]);
      const decisions = [first, second].map((result) => result.decision).sort();
      assert.deepEqual(decisions, ["allow", "block"]);
      assert.ok([first.reason, second.reason].includes("lock-held"));
      const persisted = readAiuContinuationState(resolveAiuContinuationPaths(target, getDefaultAiuConfig()));
      assert.equal(persisted?.deliveryState, "emitted");
      assert.ok(["session-a", "session-b"].includes(persisted?.ownerSessionId ?? ""));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("recovers a persisted reservation that was never emitted", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({ tool: "codex", stopHookBlocking: true, trustedState: activeWorkState() });
    try {
      const paths = resolveAiuContinuationPaths(target, getDefaultAiuConfig());
      const first = await runAiuHookStop({
        tool: "codex", cwd: target, observedAt, stdin: JSON.stringify(stopPayload(target, "reserved-session")),
      });
      assert.equal(first.decision, "block");
      const emitted = readAiuContinuationState(paths)!;
      await writeFile(paths.statePath, `${JSON.stringify({
        ...emitted,
        deliveryState: "reserved",
        lastPromptFingerprint: undefined,
        lastPromptAt: undefined,
      }, null, 2)}\n`, "utf8");

      const recovered = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt: "2026-05-23T00:01:00.000Z",
        stdin: JSON.stringify(stopPayload(target, "reserved-session")),
      });

      assert.equal(recovered.decision, "block");
      assert.equal(readAiuContinuationState(paths)?.deliveryState, "emitted");
      assert.match(await readFile(paths.logPath, "utf8"), /reservation-recovered/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("suppresses restart duplicates, records later consumption evidence, and rejects competing sessions", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({ tool: "claude-code", stopHookBlocking: true, trustedState: activeWorkState() });
    try {
      const first = await runAiuHookStop({
        tool: "claude-code", cwd: target, observedAt, stdin: JSON.stringify(stopPayload(target, "owner-session")),
      });
      assert.equal(first.decision, "block");

      const competing = await runAiuHookStop({
        tool: "claude-code", cwd: target, observedAt: "2026-05-23T00:01:00.000Z", stdin: JSON.stringify(stopPayload(target, "other-session")),
      });
      assert.equal(competing.decision, "allow");
      assert.equal(competing.reason, "prompt-owned-by-other-session");
      assert.equal(readAiuContinuationState(resolveAiuContinuationPaths(target, getDefaultAiuConfig()))?.deliveryState, "emitted");

      const replay = await runAiuHookStop({
        tool: "claude-code", cwd: target, observedAt: "2026-05-23T00:20:00.000Z", stdin: JSON.stringify(stopPayload(target, "owner-session")),
      });
      assert.equal(replay.decision, "allow");
      assert.ok(["duplicate-prompt-target", "duplicate-prompt-fingerprint"].includes(replay.reason));
      const consumed = readAiuContinuationState(resolveAiuContinuationPaths(target, getDefaultAiuConfig()));
      assert.equal(consumed?.deliveryState, "consumed");
      assert.equal(consumed?.pendingPromptFingerprint, undefined);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("enforces cooldowns, native loop limits, and the dedicated hook deadline", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const cooldownTarget = await createRepo({
      tool: "codex", stopHookBlocking: true, trustedState: activeWorkState(), promptCooldownMs: 600_000,
    });
    const deadlineTarget = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedCommand: [process.execPath, "-e", "setTimeout(() => process.stdout.write('{}'), 1000)"],
      hookMs: 150,
      hostMs: 500,
    });
    try {
      const first = await runAiuHookStop({ tool: "codex", cwd: cooldownTarget, observedAt, stdin: JSON.stringify(stopPayload(cooldownTarget, "loop-session")) });
      assert.equal(first.decision, "block");
      const cooldown = await runAiuHookStop({ tool: "codex", cwd: cooldownTarget, observedAt: "2026-05-23T00:01:00.000Z", stdin: JSON.stringify(stopPayload(cooldownTarget, "loop-session")) });
      assert.equal(cooldown.decision, "allow");
      assert.equal(cooldown.reason, "wait-cooldown-active");

      const paths = resolveAiuContinuationPaths(cooldownTarget, getDefaultAiuConfig());
      const current = readAiuContinuationState(paths)!;
      await writeFile(paths.statePath, `${JSON.stringify({ ...current, deliveryState: "consumed", nativeLoopCount: 3, pendingPromptFingerprint: undefined, pendingPromptAt: undefined }, null, 2)}\n`, "utf8");
      const exhausted = await runAiuHookStop({ tool: "codex", cwd: cooldownTarget, observedAt: "2026-05-23T00:20:00.000Z", stdin: JSON.stringify(stopPayload(cooldownTarget, "loop-session")) });
      assert.equal(exhausted.decision, "allow");
      const log = await readFile(paths.logPath, "utf8");
      assert.match(log, /native-loop-limit-exhausted/);

      const started = Date.now();
      const deadline = await runAiuHookStop({ tool: "codex", cwd: deadlineTarget, stdin: JSON.stringify(stopPayload(deadlineTarget, "deadline-session")) });
      assert.equal(deadline.decision, "allow");
      assert.equal(deadline.reason, "hook-deadline-exhausted");
      assert.ok(Date.now() - started < 750);
    } finally {
      await rm(cooldownTarget, { recursive: true, force: true });
      await rm(deadlineTarget, { recursive: true, force: true });
    }
  });

  it("fails safe on invalid state and keeps emitted state valid when logging or serialization fails", async () => {
    const { formatHookStopJson, runAiuHookStop } = await loadHookStop();
    const invalidTarget = await createRepo({ tool: "codex", stopHookBlocking: true, trustedState: activeWorkState() });
    const logFailureTarget = await createRepo({ tool: "codex", stopHookBlocking: true, trustedState: activeWorkState() });
    try {
      const invalidPaths = resolveAiuContinuationPaths(invalidTarget, getDefaultAiuConfig());
      await mkdir(invalidPaths.stateDir, { recursive: true });
      await writeFile(invalidPaths.statePath, "{\"schemaVersion\":2,\"deliveryState\":\"emitted\"}\n", "utf8");
      const invalid = await runAiuHookStop({ tool: "codex", cwd: invalidTarget, stdin: JSON.stringify(stopPayload(invalidTarget, "invalid-session")) });
      assert.equal(invalid.decision, "allow");
      assert.equal(invalid.reason, "continuation-state-invalid");
      assert.equal(existsSync(invalidPaths.lockPath), false);

      const logFailurePaths = resolveAiuContinuationPaths(logFailureTarget, getDefaultAiuConfig());
      const configPath = path.join(logFailureTarget, ".qube", "aiu", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as { trustedStateCommands: { work: { argv: string[] } } };
      config.trustedStateCommands.work.argv = [
        process.execPath,
        "-e",
        `const fs=require("node:fs");fs.rmSync(${JSON.stringify(logFailurePaths.logDir)},{recursive:true,force:true});fs.writeFileSync(${JSON.stringify(logFailurePaths.logDir)},"not a directory");process.stdout.write(${JSON.stringify(JSON.stringify(activeWorkState()))})`,
      ];
      await writeFile(configPath, JSON.stringify(config), "utf8");
      const emitted = await runAiuHookStop({ tool: "codex", cwd: logFailureTarget, stdin: JSON.stringify(stopPayload(logFailureTarget, "log-session")) });
      assert.equal(emitted.decision, "block");
      assert.equal(readAiuContinuationState(logFailurePaths)?.deliveryState, "emitted");
      assert.equal(existsSync(logFailurePaths.lockPath), false);

      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      assert.throws(() => formatHookStopJson({ ...emitted, stdoutJson: cyclic as never }), /circular/i);
      assert.equal(readAiuContinuationState(logFailurePaths)?.deliveryState, "emitted");
    } finally {
      await rm(invalidTarget, { recursive: true, force: true });
      await rm(logFailureTarget, { recursive: true, force: true });
    }
  });

  it("blocks Grok Build stops from a camelCase Stop payload", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "grok-build",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "grok-build",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(grokStopPayload(target, "grok-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Continue active work/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("does not accept a Claude snake_case-only payload as a Grok parse", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "grok-build",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "grok-build",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "claude-session")),
      });

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "malformed-hook-input");
      assert.match(result.stderr, /Claude snake_case Stop input is not a valid Grok parse/);
      assert.equal("decision" in result.stdoutJson, false);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("does not follow an untrusted payload cwd to another repository", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const victim = await createRepo({
      tool: "grok-build",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    const attackerMarker = path.join(tmpdir(), `aiu-hook-attacker-${Date.now()}.marker`);
    const attacker = await createRepo({
      tool: "grok-build",
      stopHookBlocking: true,
      trustedCommand: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(attackerMarker)}, "ran")`],
    });
    try {
      const result = await runAiuHookStop({
        tool: "grok-build",
        cwd: victim,
        observedAt,
        stdin: JSON.stringify(grokStopPayload(attacker, "attacker-session")),
      });

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "untrusted-hook-cwd");
      assert.equal(existsSync(attackerMarker), false);
    } finally {
      await rm(victim, { recursive: true, force: true });
      await rm(attacker, { recursive: true, force: true });
    }
  });

  it("fail-opens a Grok session-end Stop instead of blocking", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "grok-build",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "grok-build",
        cwd: target,
        observedAt,
        stdin: JSON.stringify({ ...grokStopPayload(target, "grok-session"), reason: "channel_closed" }),
      });

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "session-end-stop");

      const aborted = await runAiuHookStop({
        tool: "grok-build",
        cwd: target,
        observedAt,
        stdin: JSON.stringify({ ...grokStopPayload(target, "grok-session"), reason: "abort" }),
      });
      assert.equal(aborted.decision, "allow");
      assert.equal(aborted.reason, "session-end-stop");
      assert.equal(readAiuContinuationState(resolveAiuContinuationPaths(target, getDefaultAiuConfig())), undefined);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("blocks Claude Code stops with the same host JSON shape", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "claude-code",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "claude-code",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "claude-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Continue active work/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("accepts Stop hook payloads that omit optional host fields", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const { transcript_path: _transcriptPath, last_assistant_message: _lastAssistantMessage, ...payload } = stopPayload(target, "codex-session");
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(payload),
      });

      assert.equal(result.decision, "block");
      assert.equal(result.stderr, "");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("surfaces bounded trusted-state warnings without contaminating stdout JSON", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const state = activeWorkState();
    const stderrPayload = JSON.stringify("x".repeat(400));
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: undefined,
      trustedCommand: [
        process.execPath,
        "-e",
        `process.stderr.write(${stderrPayload}); process.stdout.write(${JSON.stringify(JSON.stringify(state))})`,
      ],
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.equal(result.diagnostics[0]?.code, "trusted-command-stderr");
      assert.match(result.diagnostics[0]?.message ?? "", /output was omitted/);
      assert.doesNotMatch(result.stderr, /x{20}/);
      assert.match(result.stderr, /trusted-command-stderr/);
      assert.doesNotMatch(JSON.stringify(result.stdoutJson), /trusted-command-stderr/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("caps the total diagnostic lines written to stderr", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await mkdtemp(path.join(tmpdir(), "aiu-hook-stop-noisy-"));
    try {
      await mkdir(path.join(target, ".git"));
      await mkdir(path.join(target, ".qube", "aiu"), { recursive: true });
      await writeFile(path.join(target, ".qube", "aiu", "config.json"), JSON.stringify({
        version: 1,
        hosts: {
          enabled: ["codex"],
          stopHookBlocking: {
            codex: true,
          },
        },
        trustedStateCommands: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`1bad${index}`, {}])),
      }), "utf8");

      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });
      const lines = result.stderr.trim().split("\n");

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "config-invalid");
      assert.equal(lines.length, 8);
      assert.match(lines.at(-1) ?? "", /diagnostics-truncated/);
      assert.equal(result.diagnostics.length > 8, true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("allows when stop-hook blocking is not explicitly enabled", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: false,
      modes: ["stop"],
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "stop-hook-blocking-disabled");
      assert.deepEqual(result.stdoutJson, {});
      assert.match(result.stderr, /stop-hook-blocking-disabled/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("does not continue when the host policy allows only stop", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      modes: ["stop"],
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "allow");
      assert.equal(result.continuationDecision?.kind, "stop");
      assert.equal(result.reason, "stop-safety-block");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("blocks stop hooks with a shared whip prompt when higher-priority work is idle", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: emptyWorkState(),
      postIssueScope: "standard",
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal(result.reason, "continue-whip-task");
      assert.equal(result.continuationDecision?.promptKind, "whip");
      assert.equal(result.prompt?.kind, "whip");
      assert.equal(result.prompt?.selectedItem?.id, "improve-repository-quality");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Prompt delivery does not complete the whip task/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("allows clean stop, wait, malformed input, and trusted-state failures", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const clean = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: emptyWorkState(),
      whipEnabled: false,
    });
    const failing = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: undefined,
      trustedCommand: [process.execPath, "-e", `process.stderr.write("token=${"ghp_" + "A".repeat(36)}"); process.exit(2)`],
    });
    try {
      const cleanResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify(stopPayload(clean, "codex-session")),
      });
      assert.equal(cleanResult.decision, "allow");
      assert.equal(cleanResult.reason, "stop-clean");
      assert.deepEqual(cleanResult.stdoutJson, {});

      const activeHookResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ ...stopPayload(clean, "codex-session"), stop_hook_active: true }),
      });
      assert.equal(activeHookResult.decision, "allow");
      assert.equal(activeHookResult.reason, "stop-hook-already-active");

      const emptyResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: "",
      });
      assert.equal(emptyResult.decision, "allow");
      assert.equal(emptyResult.reason, "empty-hook-input");
      assert.match(emptyResult.stderr, /empty-hook-input/);

      const malformedResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: "{",
      });
      assert.equal(malformedResult.decision, "allow");
      assert.equal(malformedResult.reason, "malformed-hook-input");
      assert.match(malformedResult.stderr, /malformed-hook-input/);

      const wrongEventResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ ...stopPayload(clean, "codex-session"), hook_event_name: "PreToolUse" }),
      });
      assert.equal(wrongEventResult.decision, "allow");
      assert.equal(wrongEventResult.reason, "malformed-hook-input");
      assert.match(wrongEventResult.stderr, /Unsupported hook event/);

      const missingRequiredResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ hook_event_name: "Stop" }),
      });
      assert.equal(missingRequiredResult.decision, "allow");
      assert.equal(missingRequiredResult.reason, "malformed-hook-input");
      assert.match(missingRequiredResult.stderr, /cwd must be a non-empty string/);

      const invalidOptionalResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ ...stopPayload(clean, "codex-session"), transcript_path: 123 }),
      });
      assert.equal(invalidOptionalResult.decision, "allow");
      assert.equal(invalidOptionalResult.reason, "malformed-hook-input");
      assert.match(invalidOptionalResult.stderr, /transcript_path must be a string or null/);

      const failingResult = await runAiuHookStop({
        tool: "codex",
        cwd: failing,
        observedAt,
        stdin: JSON.stringify(stopPayload(failing, "codex-session")),
      });
      assert.equal(failingResult.decision, "allow");
      assert.equal(failingResult.reason, "trusted-state-load-failed");
      assert.match(failingResult.stderr, /trusted-command-non-zero-exit/);
      assert.doesNotMatch(failingResult.stderr, /ghp_[A-Z0-9_]+/);
      assert.equal(readAiuHostActivation(resolveAiuContinuationPaths(failing, getDefaultAiuConfig()), "codex"), undefined);
    } finally {
      await rm(clean, { recursive: true, force: true });
      await rm(failing, { recursive: true, force: true });
    }
  });
});

async function loadHookStop(): Promise<typeof HookStop> {
  return await import(pathToFileURL(path.join(repoRoot, "dist/src/hook_stop.js")).href) as typeof HookStop;
}

async function createRepo(options: {
  readonly tool: "codex" | "claude-code" | "grok-build";
  readonly stopHookBlocking: boolean;
  readonly trustedState?: Record<string, unknown>;
  readonly trustedCommand?: readonly [string, ...string[]];
  readonly whipEnabled?: boolean;
  readonly postIssueScope?: "ready" | "standard" | "custom";
  readonly modes?: readonly ("continue" | "repair" | "stop")[];
  readonly promptCooldownMs?: number;
  readonly nativeLoopLimit?: number;
  readonly hookMs?: number;
  readonly hostMs?: number;
}): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "aiu-hook-stop-"));
  await mkdir(path.join(target, ".git"));
  await mkdir(path.join(target, ".qube", "aiu"), { recursive: true });
  const trustedCommand = options.trustedCommand ?? [
    process.execPath,
    "-e",
    `process.stdout.write(${JSON.stringify(JSON.stringify(options.trustedState ?? emptyWorkState()))})`,
  ] as const;
  await writeFile(path.join(target, ".qube", "aiu", "config.json"), JSON.stringify({
    version: 1,
    postIssueScope: options.postIssueScope ?? "ready",
    hosts: {
      enabled: [options.tool],
      capabilities: {
        [options.tool]: {
          stopHook: true,
          promptDelivery: "stdout",
        },
      },
      modes: {
        [options.tool]: options.modes ?? ["continue", "repair", "stop"],
      },
      stopHookBlocking: options.stopHookBlocking ? { [options.tool]: true } : {},
    },
    trustedStateCommands: {
      work: {
        argv: trustedCommand,
        timeoutMs: 1_000,
        maxOutputBytes: 16_384,
      },
    },
    continuation: {
      nativeLoopLimit: options.nativeLoopLimit ?? 3,
    },
    cooldowns: {
      promptMs: options.promptCooldownMs ?? 600_000,
    },
    timeouts: {
      hookMs: options.hookMs ?? 4_000,
      hostMs: options.hostMs ?? 5_000,
    },
    ...(options.whipEnabled === false ? { whip: { enabled: false } } : {}),
  }), "utf8");
  return target;
}

function grokStopPayload(cwd: string, sessionId: string) {
  return {
    cwd,
    hookEventName: "stop",
    lastAssistantMessage: "done",
    permissionMode: "default",
    reason: "end_turn",
    sessionId,
    stopHookActive: false,
    timestamp: observedAt,
    workspaceRoot: cwd,
  };
}

function stopPayload(cwd: string, sessionId: string) {
  return {
    cwd,
    hook_event_name: "Stop",
    last_assistant_message: "done",
    model: "test-model",
    permission_mode: "default",
    session_id: sessionId,
    stop_hook_active: false,
    transcript_path: null,
    turn_id: "turn-1",
  };
}

function activeWorkState(options: { readonly diagnostics?: readonly Record<string, unknown>[] } = {}) {
  return {
    schemaVersion: 1,
    sourceId: "work",
    observedAt,
    trustLevel: "trusted",
    capabilities: {
      work: "supported",
    },
    freshness: {
      kind: "fresh",
      observedAt,
    },
    value: {
      kind: "work-queue",
      status: "pass",
      activeItems: [{
        kind: "work-item",
        status: "pass",
        id: "66",
        title: "Implement stop hooks",
        lifecycle: "active",
        priority: "high",
        blockers: [],
      }],
      readyItems: [],
      blockedItems: [],
      unknownItems: [],
    },
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  };
}

function emptyWorkState() {
  return {
    schemaVersion: 1,
    sourceId: "work",
    observedAt,
    trustLevel: "trusted",
    capabilities: {
      work: "supported",
    },
    freshness: {
      kind: "fresh",
      observedAt,
    },
    value: {
      kind: "work-queue",
      status: "pass",
      activeItems: [],
      readyItems: [],
      blockedItems: [],
      unknownItems: [],
    },
  };
}
