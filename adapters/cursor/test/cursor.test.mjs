import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
  it("builds one fresh read-only JSON invocation with no publishing or approval flags", () => {
    const built = cursor.buildCursorInvocation(context, "linux");
    assert.deepEqual(built.args.slice(0, 7), ["--print", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled"]);
    assert.equal(built.stdin, "inspect");
    for (const forbidden of ["--force", "--yolo", "--resume", "--continue", "--approve-mcps", "--auto-review", "--trust", "--worktree", "--api-key"]) {
      assert.equal(built.args.includes(forbidden), false);
    }
  });

  it("never builds an invocation that weakens sandbox isolation", () => {
    const built = cursor.buildCursorInvocation(context, "win32");
    assert.ok(built.args.includes("ask"));
    assert.deepEqual(built.args.slice(5, 7), ["--sandbox", "enabled"]);
  });

  it("parses exactly one successful terminal result", () => {
    const valid = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"status\":\"passed\"}", session_id: "fresh" });
    assert.deepEqual(cursor.parseCursorEnvelope(valid), { text: '{"status":"passed"}', sessionId: "fresh" });
    assert.equal(cursor.parseCursorEnvelope(`${valid}\n${valid}`), null);
    assert.equal(cursor.parseCursorEnvelope(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "failed" })), null);
    assert.equal(cursor.parseCursorEnvelope('{"type":"assistant"}'), null);
  });

  it("parses authentication without returning account fields", () => {
    assert.equal(cursor.parseCursorStatus(JSON.stringify({ status: "authenticated", isAuthenticated: true, userInfo: { email: "private@example.test" } })), true);
    assert.equal(cursor.parseCursorStatus(JSON.stringify({ status: "unauthenticated", isAuthenticated: false })), false);
    assert.equal(cursor.parseCursorStatus("logged in"), null);
  });

  it("parses the official model catalog", () => {
    assert.deepEqual(cursor.parseCursorModelCatalog("Available models\n\nauto - Auto\ngpt-5.6-luna-high - GPT\nTip: use --model"), ["auto", "gpt-5.6-luna-high"]);
  });

  it("resolves the Windows PowerShell shim without a command shell", () => {
    const shim = "C:\\Users\\test\\cursor-agent\\cursor-agent.cmd";
    const resolved = cursor.resolveCursorWindowsShim(shim, "C:\\Windows", path => path.endsWith("cursor-agent.ps1") || path.endsWith("powershell.exe"));
    assert.equal(resolved.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(resolved.prefixArgs.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  });

  it("fails closed for version, capability, authentication, catalog, and model faults", () => {
    const output = (args) => {
      if (args.at(-1) === "--help") return "--print --output-format --mode ask --model --workspace --sandbox";
      if (args.includes("status")) return JSON.stringify({ status: "authenticated", isAuthenticated: true });
      if (args.at(-1) === "models") return "Available models\nmodel-a - Model A";
      return "";
    };
    const base = { model: "model-a", executable: "cursor-agent", prefixArgs: [], runCommand: (_exe, args) => output(args), version: "2026.08.11-build" };
    assert.equal(cursor.probeCursor(base, "linux").status, "ready");
    assert.equal(cursor.probeCursor(base, "win32").status, "blocked");
    assert.match(cursor.probeCursor(base, "win32").diagnostic, /WSL2/);
    assert.equal(cursor.probeCursor({ ...base, version: "cursor-dev" }, "linux").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, version: "2025.01.01-old" }, "linux").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, runCommand: (_exe, args) => args.includes("status") ? JSON.stringify({ status: "unauthenticated", isAuthenticated: false }) : output(args) }, "linux").status, "blocked");
    assert.equal(cursor.probeCursor({ ...base, model: "missing" }, "linux").modelListed, false);
    assert.equal(cursor.probeCursor({ ...base, runCommand: (_exe, args) => args.at(-1) === "--help" ? "--print" : output(args) }, "linux").status, "blocked");
  });
});
