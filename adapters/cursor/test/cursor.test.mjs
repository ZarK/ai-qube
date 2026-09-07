import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as cursor from "../dist/index.js";

const context = {
  repoRoot: "/repo",
  model: "gpt-5.6-luna-high",
  effort: null,
  maxTurns: 8,
  prompt: "inspect",
  promptPath: null,
  schemaPath: null,
  schemaJson: "{}",
};

describe("Cursor isolated review adapter", () => {
  it("publishes a truthful Cursor host profile", () => {
    assert.deepEqual(cursor.cursorHostProfile.executables, {
      names: ["cursor-agent"],
      windowsNames: ["cursor-agent.exe"],
    });
    assert.equal(cursor.cursorHostProfile.instructionTarget.path, "AGENTS.md");
    assert.equal(cursor.cursorHostProfile.makeItSo.path, ".cursor/commands/make-it-so.md");
    assert.equal(cursor.cursorHostProfile.makeItSo.invocation, "/make-it-so");
    assert.equal("commandTargets" in cursor.cursorHostProfile, false);
    assert.equal("instructionTargets" in cursor.cursorHostProfile, false);
    assert.equal("todo" in cursor.cursorHostProfile, false);
    assert.equal("dialogue" in cursor.cursorHostProfile, false);
    assert.equal("hooks" in cursor.cursorHostProfile, false);
    assert.equal("supportsProjectCommands" in cursor.cursorHostProfile, false);
    assert.equal(cursor.cursorHostProfile.taskList.support, "unsupported");
    assert.equal(cursor.cursorHostProfile.subagents.support, "unsupported");
    assert.equal(cursor.cursorHostProfile.review.local.support, "unsupported");
    assert.deepEqual(cursor.cursorHostProfile.review.local.agents, []);
    assert.equal(cursor.cursorHostProfile.review.isolated.support, "supported");
    assert.equal(cursor.cursorHostProfile.review.isolated.readOnly, true);
    assert.deepEqual(cursor.cursorHostProfile.review.isolated.agents, []);
    assert.equal("executableNames" in cursor.cursorHostProfile.modelDiscovery, false);
    assert.equal(cursor.cursorHostProfile.umpire.continuation.support, "supported");
    assert.equal(cursor.cursorHostProfile.umpire.continuation.delivery, "stdout");
    assert.equal(cursor.cursorHostProfile.umpire.continuation.currentIssueRecovery, true);
    assert.equal(cursor.cursorHostProfile.trust.required, true);
    assert.deepEqual(cursor.cursorHostProfile.trust.actions[0].paths, [".cursor/hooks.json"]);

    const calls = [];
    const models = cursor.cursorHostProfile.modelDiscovery.listModels({
      executable: "node",
      prefixArgs: ["cursor-script.js"],
      runCommand(executable, args) {
        calls.push([executable, args]);
        if (args.at(-1) === "--acp-models") return JSON.stringify({ version: 1, transport: "acp", options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] });
        return "Available models\nmodel-a - Model A\nmodel-b - Model B\n";
      },
    });
    assert.deepEqual(models, ["model-a", "model-b"]);
    assert.deepEqual(calls, process.platform === "win32"
      ? [["node", ["cursor-script.js", "models"]], ["node", ["cursor-script.js", "--acp-models"]]]
      : [["node", ["cursor-script.js", "models"]]]);
  });

  it("implements the Cursor Stop-hook continuation contract", () => {
    const adapter = cursor.cursorContinuationAdapter;
    assert.equal(adapter.declaration.hostId, "cursor");
    assert.deepEqual(adapter.declaration.nativeSurfaces, [{ id: "stop-hook", minimumVersion: "2026.08.11", maximumVersionExclusive: null }]);
    assert.deepEqual(adapter.declaration.delivery, { method: "stdout-json", sessionScope: "current-session" });
    assert.deepEqual(adapter.declaration.umpireModes, ["continue", "repair", "stop"]);
    assert.equal(adapter.declaration.currentIssueRecovery, true);

    const decoded = adapter.decodeEvent(cursorStopPayload());
    assert.deepEqual(decoded, {
      ok: true,
      event: {
        event: "stop",
        sessionId: "conversation-1",
        generationId: "generation-1",
        harnessVersion: "2026.08.11-e8db854",
        workspaceRoots: ["/repo"],
        hostStatus: "completed",
        nativeLoopCount: 0,
        sessionEnd: false,
      },
    });
    assert.deepEqual(adapter.encodeResponse({ decision: "allow" }).response, {});
    assert.deepEqual(adapter.encodeResponse({ decision: "block", prompt: "Continue safely." }).response, { followup_message: "Continue safely." });
    assert.equal(adapter.encodeResponse({ decision: "block", prompt: " " }).ok, false);
    assert.equal(adapter.probe({ surface: "plugin-event", version: "2026.08.11" }).status, "blocked");
    assert.equal(adapter.probe({ surface: "stop-hook", version: "2026.08.10" }).status, "blocked");
    assert.equal(adapter.probe({ surface: "stop-hook", version: "2026.08.11" }).status, "ready");
    assert.equal(adapter.probe({ surface: "stop-hook", version: "2026.08.11", repoRoot: "/repo" }).code, "cursor-hook-trust-unverified");
  });

  it("rejects malformed, unsafe, and non-completed Cursor Stop payloads", () => {
    const adapter = cursor.cursorContinuationAdapter;
    const failures = [
      null,
      {},
      { ...cursorStopPayload(), hook_event_name: "Stop" },
      { ...cursorStopPayload(), conversation_id: "" },
      { ...cursorStopPayload(), generation_id: null },
      { ...cursorStopPayload(), cursor_version: 1 },
      { ...cursorStopPayload(), status: "cancelled" },
      { ...cursorStopPayload(), loop_count: -1 },
      { ...cursorStopPayload(), loop_count: 1.5 },
      { ...cursorStopPayload(), workspace_roots: [] },
      { ...cursorStopPayload(), workspace_roots: ["/repo", 42] },
    ];
    for (const value of failures) assert.equal(adapter.decodeEvent(value).ok, false);
    assert.equal(adapter.decodeEvent({ ...cursorStopPayload(), status: "aborted" }).event.sessionEnd, true);
    assert.equal(adapter.decodeEvent({ ...cursorStopPayload(), status: "error" }).event.sessionEnd, true);
  });

  it("semantically merges one finite managed Stop hook and preserves unrelated Cursor configuration", () => {
    const adapter = cursor.cursorContinuationAdapter;
    const desired = adapter.renderManagedAssets({ packageVersions: { "@tjalve/aiu": "0.0.14" }, commandPrefix: "node node_modules/@tjalve/aiu/bin/run" })[0];
    assert.equal(desired.relativePath, ".cursor/hooks.json");
    const desiredJson = JSON.parse(desired.content);
    assert.equal(desiredJson.hooks.stop[0].loop_limit, 3);
    assert.match(desiredJson.hooks.stop[0].command, /hook-stop --tool cursor$/);

    const existing = JSON.stringify({ version: 1, theme: "dark", hooks: { afterFileEdit: [{ command: "format" }], stop: [{ command: "audit" }] } });
    const merged = adapter.mergeManagedAsset(desired.id, existing, desired);
    assert.equal(merged.ok, true);
    const value = JSON.parse(merged.content);
    assert.equal(value.theme, "dark");
    assert.deepEqual(value.hooks.afterFileEdit, [{ command: "format" }]);
    assert.deepEqual(value.hooks.stop.map(entry => entry.command), ["audit", desiredJson.hooks.stop[0].command]);
    assert.equal(adapter.validateManagedAsset(desired.id, merged.content, desired).state, "current");
    const rerun = adapter.mergeManagedAsset(desired.id, merged.content, desired);
    assert.equal(rerun.ok, true);
    assert.equal(rerun.changed, false);
    assert.equal(rerun.content, merged.content);

    const conflicting = JSON.stringify({ version: 1, hooks: { stop: [{ command: "aiu hook-stop --tool cursor", loop_limit: null }] } });
    assert.equal(adapter.validateManagedAsset(desired.id, conflicting, desired).state, "conflicting");
    assert.equal(adapter.mergeManagedAsset(desired.id, conflicting, desired).ok, false);
    const duplicate = JSON.stringify({ version: 1, hooks: { stop: [desiredJson.hooks.stop[0], desiredJson.hooks.stop[0]] } });
    assert.equal(adapter.validateManagedAsset(desired.id, duplicate, desired).state, "duplicate");
    assert.equal(adapter.mergeManagedAsset(desired.id, duplicate, desired).ok, false);
    assert.equal(adapter.mergeManagedAsset(desired.id, "[]", desired).ok, false);
  });

  it("builds an explicit-model verification invocation without trust or session-control flags", () => {
    const invocation = cursor.buildCursorVerifyInvocation({ root: "/repo", prompt: "verify", model: "gpt-5.4-nano-none", platform: "linux" });
    assert.deepEqual(invocation.args, ["--disable-auto-update", "--sandbox", "enabled", "--model", "gpt-5.4-nano-none", "--workspace", "/repo", "verify"]);
    const windows = cursor.buildCursorVerifyInvocation({ root: "C:\\repo", prompt: "verify", model: "gpt-5.4-nano-none", platform: "win32" });
    assert.deepEqual(windows.args, ["--disable-auto-update", "--model", "gpt-5.4-nano-none", "--workspace", "C:\\repo", "verify"]);
    assert.throws(() => cursor.buildCursorVerifyInvocation({ root: "/repo", prompt: "verify" }), /explicit model/);
    for (const forbidden of ["--print", "--output-format", "--trust", "--continue", "--resume", "--worktree", "--force", "--yolo", "--approve-mcps"]) {
      assert.equal(invocation.args.includes(forbidden), false);
      assert.equal(windows.args.includes(forbidden), false);
    }
    assert.equal(windows.args.includes("--sandbox"), false);
  });

  it("accepts bounded current Cursor Stop observations with assistant transcript evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-observer-test-"));
    try {
      const stateDir = path.join(root, ".qube", "aiu");
      mkdirSync(stateDir, { recursive: true });
      const transcriptRoot = path.join(root, "cursor-data", "agent-transcripts");
      const transcriptPath = path.join(transcriptRoot, "conversation", "conversation.jsonl");
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const transcript = [
        { role: "user", message: { content: [{ type: "text", text: "AIU_VERIFY_INITIAL:user-echo" }] } },
        { role: "assistant", message: { content: [{ type: "text", text: "AIU_VERIFY_INITIAL:nonce" }] } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n";
      writeFileSync(transcriptPath, transcript);
      const observedAt = new Date().toISOString();
      const observationPath = path.join(stateDir, "verify-cursor-observations.jsonl");
      writeFileSync(observationPath, JSON.stringify({ conversation_id: "conversation", generation_id: "generation", cursor_version: "2026.08.11-e8db854", hook_event_name: "stop", status: "completed", loop_count: 0, workspace_roots: [root], transcript_path: transcriptPath, transcript, observed_at: observedAt }) + "\n");
      const observations = cursor.inspectCursorVerificationObservations({ observationPath, workspaceRoot: root, transcriptRoot, startedAt: Date.parse(observedAt) - 1, expectedVersion: "2026.08.11-e8db854" });
      assert.equal(observations.length, 1);
      assert.deepEqual(observations[0].assistantMessages, ["AIU_VERIFY_INITIAL:nonce"]);

      const stale = cursor.inspectCursorVerificationObservations({ observationPath, workspaceRoot: root, transcriptRoot, startedAt: Date.parse(observedAt) + 1, expectedVersion: "2026.08.11-e8db854" });
      assert.deepEqual(stale, []);
      const mismatch = cursor.inspectCursorVerificationObservations({ observationPath, workspaceRoot: root, transcriptRoot, startedAt: Date.parse(observedAt) - 1, expectedVersion: "2026.08.12" });
      assert.deepEqual(mismatch, []);
      assert.equal(cursor.resolveCursorVerificationTranscriptRoot("C:\\Odd path\\a_b...", "C:\\CursorData"), path.join("C:\\CursorData", "projects", "C-Odd-path-a-b", "agent-transcripts"));

      const dataRoot = path.join(root, "native-data");
      const nativeTranscriptRoot = cursor.resolveCursorVerificationTranscriptRoot(root, dataRoot);
      const nativeTranscript = path.join(nativeTranscriptRoot, "conversation", "conversation.jsonl");
      mkdirSync(path.dirname(nativeTranscript), { recursive: true });
      writeFileSync(nativeTranscript, `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "request" }] } })}\n`);
      rmSync(observationPath, { force: true });
      const observerPath = path.join(stateDir, "observer.cjs");
      writeFileSync(observerPath, cursor.cursorVerificationObserverScript({ workspaceRoot: root, cursorDataRoot: dataRoot }));
      const child = spawn(process.execPath, [observerPath], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.resume();
      child.stdin.end(JSON.stringify({ conversation_id: "conversation", generation_id: "generation", cursor_version: "2026.08.11-e8db854", hook_event_name: "stop", status: "completed", loop_count: 0, workspace_roots: [root], transcript_path: nativeTranscript }));
      setTimeout(() => writeFileSync(nativeTranscript, transcript), 100);
      const [exitCode] = await once(child, "close");
      assert.equal(exitCode, 0);
      const flushed = cursor.inspectCursorVerificationObservations({ observationPath, workspaceRoot: root, transcriptRoot: nativeTranscriptRoot, startedAt: Date.now() - 3000, expectedVersion: "2026.08.11-e8db854" });
      assert.equal(flushed.length, 1);
      assert.deepEqual(flushed[0].assistantMessages, ["AIU_VERIFY_INITIAL:nonce"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports Windows, macOS, and Linux with a direct Windows shim resolution", () => {
    assert.equal(cursor.isolatedReviewHostAdapter.supportsPlatform("win32"), true);
    assert.equal(cursor.isolatedReviewHostAdapter.supportsPlatform("linux"), true);
    assert.equal(cursor.isolatedReviewHostAdapter.supportsPlatform("darwin"), true);
    const versionRoot = "C:\\Tools\\versions\\2026.08.11-e8db854";
    assert.deepEqual(
      cursor.resolveCursorWindowsShim(
        "C:\\Tools\\cursor-agent.cmd",
        path => path === `${versionRoot}\\node.exe` || path === `${versionRoot}\\index.js`,
        undefined,
        () => ["2026.08.11-e8db854"],
      ),
      {
        executable: process.execPath,
        prefixArgs: [
          fileURLToPath(new URL("../dist/cursor-acp-runner.js", import.meta.url)),
          "--cursor-executable",
          `${versionRoot}\\node.exe`,
          "--cursor-prefix-json",
          JSON.stringify([`${versionRoot}\\index.js`]),
          "--",
        ],
      },
    );
    assert.equal(cursor.resolveCursorWindowsShim("C:\\Tools\\cursor-agent.cmd", () => false, undefined, () => ["2026.08.11-e8db854"]), null);
    const newest = cursor.resolveCursorWindowsShim("C:\\Tools\\cursor-agent.cmd", () => true, undefined, () => ["2026.9.30-a", "2026.10.1-b"]);
    assert.match(newest.prefixArgs.join("\n"), /2026\.10\.1-b/);
  });

  it("builds one fresh read-only JSON invocation with no publishing or approval flags", () => {
    const built = cursor.buildCursorInvocation(context, "linux");
    assert.deepEqual(built.args.slice(0, 7), ["--print", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled"]);
    assert.match(built.stdin, /^inspect\n\nThe following JSON Schema/);
    assert.match(built.stdin, /\{\}$/);
    for (const forbidden of ["--force", "--yolo", "--resume", "--continue", "--approve-mcps", "--auto-review", "--trust", "--worktree", "--api-key"]) {
      assert.equal(built.args.includes(forbidden), false);
    }
  });

  it("routes Windows review through the permission-denying ACP client", () => {
    const built = cursor.buildCursorInvocation({ ...context, transportModel: "gpt-5.6-luna[reasoning=high]" }, "win32");
    assert.deepEqual(built.args, ["--acp-review", "--model", "gpt-5.6-luna[reasoning=high]", "--requested-model", "gpt-5.6-luna-high", "--workspace", "/repo"]);
    assert.match(built.stdin, /^inspect\n\nCursor ACP review capability boundary:/);
    assert.match(built.stdin, /Do not request shell or terminal commands/);
    assert.match(built.stdin, /\{\}$/);
    assert.equal(built.args.includes("--sandbox"), false);
    assert.equal(built.args.includes("disabled"), false);
    assert.deepEqual(cursor.buildCursorInvocation({ ...context, model: null }, "win32").args, ["--acp-review", "--workspace", "/repo"]);
  });

  it("rejects a separate effort instead of recording an effort that Cursor did not use", () => {
    for (const platform of ["win32", "linux"]) {
      assert.throws(
        () => cursor.buildCursorInvocation({ ...context, effort: "high" }, platform),
        /does not support a separate reasoning effort/,
      );
    }
  });

  it("accepts clean JSON-only results from exactly one successful terminal result", () => {
    const valid = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"status\":\"passed\"}", session_id: "fresh" });
    assert.deepEqual(cursor.parseCursorEnvelope(valid), { text: '{"status":"passed"}', sessionId: "fresh" });
    assert.deepEqual(cursor.parseCursorEnvelope(`starting review\n${JSON.stringify({ type: "progress", message: "reading" })}\n${valid}\ntelemetry`), { text: '{"status":"passed"}', sessionId: "fresh" });
    assert.equal(cursor.parseCursorEnvelope(`${valid}\n${valid}`), null);
    assert.equal(cursor.parseCursorEnvelope(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "failed" })}\n${valid}`), null);
    assert.equal(cursor.parseCursorEnvelope(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "failed" })), null);
    assert.equal(cursor.parseCursorEnvelope('{"type":"assistant"}'), null);
    const prefixed = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Delta re-review of this head. Next I will check the proofs.{\"status\":\"passed\",\"lane\":\"issue-compliance\"}",
      session_id: "fresh",
    });
    assert.deepEqual(cursor.parseCursorEnvelope(prefixed), {
      text: '{"status":"passed","lane":"issue-compliance"}',
      sessionId: "fresh",
      resultDecodeDiagnostic: "cursor-bounded-preface-normalized",
    });
    const reported = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"status\":\"passed\"}", session_id: "fresh", model: "grok-4.6" });
    assert.deepEqual(cursor.parseCursorEnvelope(reported), { text: '{"status":"passed"}', sessionId: "fresh", reportedModel: "grok-4.6" });
  });

  it("decodes one bounded Cursor preface without selecting prose braces or quoted JSON", () => {
    assert.deepEqual(cursor.decodeCursorReviewResult('{"status":"passed","details":{"count":1}}'), {
      ok: true,
      text: '{"status":"passed","details":{"count":1}}',
      diagnostic: null,
    });
    assert.deepEqual(
      cursor.decodeCursorReviewResult('Checked {not JSON} and quoted \'{"fake":true}\' plus "{\\"alsoFake\\":true}".\n{"status":"passed"}'),
      {
        ok: true,
        text: '{"status":"passed"}',
        diagnostic: "cursor-bounded-preface-normalized",
      },
    );
    assert.deepEqual(
      cursor.decodeCursorReviewResult(`${"x".repeat(1024)}{"status":"passed"}`),
      {
        ok: true,
        text: '{"status":"passed"}',
        diagnostic: "cursor-bounded-preface-normalized",
      },
    );
  });

  it("fails closed for ambiguous or unsafe Cursor final-result text with fixed diagnostics", () => {
    const failure = (result, diagnostic) => assert.deepEqual(result, {
      ok: false,
      reasonCode: "model-route-result-decode",
      diagnostic,
    });
    failure(cursor.decodeCursorReviewResult('```json\n{"status":"passed"}\n```'), "cursor-result-markdown-fence");
    failure(cursor.decodeCursorReviewResult('{"first":true}\n{"second":true}'), "cursor-result-multiple-objects");
    failure(cursor.decodeCursorReviewResult('[1,2]\n{"second":true}'), "cursor-result-json-preface");
    failure(cursor.decodeCursorReviewResult('{"status":"passed"} trailing'), "cursor-result-trailing-output");
    failure(cursor.decodeCursorReviewResult(`${"x".repeat(1025)}{"status":"passed"}`), "cursor-result-preface-limit");
    failure(cursor.decodeCursorReviewResult('{"status":"passed"'), "cursor-result-truncated-json");
    failure(cursor.decodeCursorReviewResult(`${'{"nested":'.repeat(65)}true${"}".repeat(65)}`), "cursor-result-depth-limit");
    failure(cursor.decodeCursorReviewResult('[{"status":"passed"}]'), "cursor-result-trailing-output");

    const envelope = result => JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      session_id: "fresh",
    });
    assert.deepEqual(cursor.parseCursorEnvelope(envelope('{"status":"passed"} trailing raw chatter')), {
      failureReasonCode: "model-route-result-decode",
      failureDiagnostic: "cursor-result-trailing-output",
    });
  });

  it("parses authentication without returning account fields", () => {
    assert.equal(cursor.parseCursorStatus(JSON.stringify({ status: "authenticated", isAuthenticated: true, userInfo: { email: "private@example.test" } })), true);
    assert.equal(cursor.parseCursorStatus(JSON.stringify({ status: "unauthenticated", isAuthenticated: false })), false);
    assert.equal(cursor.parseCursorStatus("logged in"), null);
  });

  it("parses the official model catalog", () => {
    assert.deepEqual(cursor.parseCursorModelCatalog("Available models\n\nauto - Auto\ngpt-5.6-luna-high - GPT\nTip: use --model"), ["auto", "gpt-5.6-luna-high"]);
  });

  it("lists only display models that preserve Windows ACP effort and speed", () => {
    const outputs = new Map([
      ["models", "Available models\ncursor-grok-4.6-high - Grok High\ncursor-grok-4.6-high-fast - Grok High Fast\ncursor-grok-4.6-medium-fast - Grok Medium Fast"],
      ["--acp-models", JSON.stringify({ version: 1, transport: "acp", options: [
        { value: "grok-4.6[effort=high,fast=true]", name: "Grok High Fast" },
        { value: "grok-4.6[effort=medium,fast=false]", name: "Grok Medium" },
      ] })],
    ]);
    const models = cursor.listCursorModels({
      executable: "node",
      prefixArgs: ["cursor-script.js"],
      runCommand: (_executable, args) => outputs.get(args.at(-1)) ?? "",
    }, "win32");
    assert.deepEqual(models, ["cursor-grok-4.6-high-fast"]);
  });

  it("accepts an exact Windows ACP model value without recording an alias substitution", () => {
    const model = "grok-4.6[effort=high,fast=true]";
    const result = cursor.probeCursor({
      model,
      executable: "cursor-agent",
      prefixArgs: [],
      version: "2026.08.11-build",
      runCommand: (_executable, args) => {
        if (args.at(-2) === "acp" && args.at(-1) === "--help") return "Usage: agent acp\nAgent Client Protocol";
        if (args.at(-1) === "--help") return "ask";
        if (args.includes("status")) return JSON.stringify({ status: "authenticated", isAuthenticated: true });
        if (args.at(-1) === "models") return "Available models\ncursor-grok-4.6-high-fast - Grok High Fast";
        if (args.at(-1) === "--acp-models") return JSON.stringify({ version: 1, transport: "acp", options: [{ value: model, name: "Grok High Fast" }] });
        return "";
      },
    }, "win32");

    assert.equal(result.status, "ready");
    assert.equal(result.modelListed, true);
    assert.equal(result.resolvedModel, model);
    assert.deepEqual(result.availableModels, ["cursor-grok-4.6-high-fast"]);
  });

  it("fails closed for version, capability, authentication, catalog, and model faults", () => {
    const output = (args) => {
      if (args.at(-2) === "acp" && args.at(-1) === "--help") return "Usage: agent acp\nStart the Cursor Agent as an ACP (Agent Client Protocol) server";
      if (args.at(-1) === "--help") return "acp --print --output-format --mode ask --model --workspace --sandbox";
      if (args.includes("status")) return JSON.stringify({ status: "authenticated", isAuthenticated: true });
      if (args.at(-1) === "models") return "Available models\nmodel-a - Model A";
      if (args.at(-1) === "--acp-models") return JSON.stringify({ version: 1, transport: "acp", options: [{ value: "model-a", name: "Model A" }] });
      return "";
    };
    const base = { model: "model-a", executable: "cursor-agent", prefixArgs: [], runCommand: (_exe, args) => output(args), version: "2026.08.11-build" };
    assert.equal(cursor.probeCursor(base, "linux").status, "ready");
    assert.equal(cursor.probeCursor(base, "win32").status, "ready");
    assert.equal(cursor.probeCursor({ ...base, runCommand: (_exe, args) => args.at(-2) === "acp" ? "Usage: agent acp" : args.at(-1) === "--help" ? "ask" : output(args) }, "win32").status, "ready");
    assert.equal(cursor.probeCursor({ ...base, runCommand: (_exe, args) => args.at(-2) === "acp" ? "unknown command" : output(args) }, "win32").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, version: "cursor-dev" }, "linux").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, version: "2025.01.01-old" }, "linux").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, runCommand: (_exe, args) => args.includes("status") ? JSON.stringify({ status: "unauthenticated", isAuthenticated: false }) : output(args) }, "linux").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, model: "missing" }, "linux").modelListed, false);
    assert.equal(cursor.probeCursor({ ...base, runCommand: (_exe, args) => args.at(-1) === "--help" ? "--print" : output(args) }, "linux").status, "blocked");

    const missingAcpCatalog = cursor.probeCursor({
      ...base,
      runCommand: (_exe, args) => args.at(-1) === "--acp-models" ? "not-json" : output(args),
    }, "win32");
    assert.equal(missingAcpCatalog.status, "blocked");
    assert.equal(missingAcpCatalog.reasonCode, "model-route-probe-blocked");

    const unlisted = cursor.probeCursor({ ...base, model: "missing" }, "win32");
    assert.equal(unlisted.status, "blocked");
    assert.equal(unlisted.reasonCode, "model-route-model-unsupported");
    assert.match(unlisted.diagnostic, /not in the Cursor CLI catalog/);
    assert.deepEqual(unlisted.availableModels, ["model-a"]);

    const incompatible = cursor.probeCursor({
      ...base,
      model: "cursor-grok-4.6-medium-fast",
      runCommand: (_exe, args) => {
        if (args.at(-2) === "acp" && args.at(-1) === "--help") return "Usage: agent acp\nAgent Client Protocol";
        if (args.at(-1) === "--help") return "ask";
        if (args.includes("status")) return JSON.stringify({ status: "authenticated", isAuthenticated: true });
        if (args.at(-1) === "models") return "Available models\ncursor-grok-4.6-medium-fast - Grok Medium Fast\ncursor-grok-4.6-high-fast - Grok High Fast";
        if (args.at(-1) === "--acp-models") return JSON.stringify({ version: 1, transport: "acp", options: [{ value: "grok-4.6[effort=high,fast=true]", name: "Grok High Fast" }] });
        return "";
      },
    }, "win32");
    assert.equal(incompatible.status, "blocked");
    assert.equal(incompatible.reasonCode, "model-route-model-unsupported");
    assert.equal(incompatible.resolvedModel, null);
    assert.deepEqual(incompatible.availableModels, ["cursor-grok-4.6-high-fast"]);
  });
});

function cursorStopPayload() {
  return {
    conversation_id: "conversation-1",
    generation_id: "generation-1",
    hook_event_name: "stop",
    cursor_version: "2026.08.11-e8db854",
    workspace_roots: ["/repo"],
    status: "completed",
    loop_count: 0,
  };
}
