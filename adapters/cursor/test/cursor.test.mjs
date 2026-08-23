import assert from "node:assert/strict";
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
      names: ["cursor-agent", "agent"],
      windowsNames: ["cursor-agent.exe", "agent.exe"],
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
    assert.equal(cursor.cursorHostProfile.umpire.continuation.support, "unsupported");
    assert.equal(cursor.cursorHostProfile.trust.required, false);

    const calls = [];
    const models = cursor.cursorHostProfile.modelDiscovery.listModels({
      executable: "node",
      prefixArgs: ["cursor-script.js"],
      runCommand(executable, args) {
        calls.push([executable, args]);
        return "Available models\nmodel-a - Model A\nmodel-b - Model B\n";
      },
    });
    assert.deepEqual(models, ["model-a", "model-b"]);
    assert.deepEqual(calls, [["node", ["cursor-script.js", "models"]]]);
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
    const built = cursor.buildCursorInvocation(context, "win32");
    assert.deepEqual(built.args, ["--acp-review", "--model", "gpt-5.6-luna-high", "--workspace", "/repo"]);
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

  it("parses exactly one successful terminal result", () => {
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
    assert.deepEqual(cursor.parseCursorEnvelope(prefixed), { text: '{"status":"passed","lane":"issue-compliance"}', sessionId: "fresh" });
  });

  it("parses authentication without returning account fields", () => {
    assert.equal(cursor.parseCursorStatus(JSON.stringify({ status: "authenticated", isAuthenticated: true, userInfo: { email: "private@example.test" } })), true);
    assert.equal(cursor.parseCursorStatus(JSON.stringify({ status: "unauthenticated", isAuthenticated: false })), false);
    assert.equal(cursor.parseCursorStatus("logged in"), null);
  });

  it("parses the official model catalog", () => {
    assert.deepEqual(cursor.parseCursorModelCatalog("Available models\n\nauto - Auto\ngpt-5.6-luna-high - GPT\nTip: use --model"), ["auto", "gpt-5.6-luna-high"]);
  });

  it("fails closed for version, capability, authentication, catalog, and model faults", () => {
    const output = (args) => {
      if (args.at(-2) === "acp" && args.at(-1) === "--help") return "Usage: agent acp\nStart the Cursor Agent as an ACP (Agent Client Protocol) server";
      if (args.at(-1) === "--help") return "acp --print --output-format --mode ask --model --workspace --sandbox";
      if (args.includes("status")) return JSON.stringify({ status: "authenticated", isAuthenticated: true });
      if (args.at(-1) === "models") return "Available models\nmodel-a - Model A";
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
  });
});
