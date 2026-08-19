import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { parseRunnerOptions, selectCursorAcpModel } from "../dist/cursor-acp-runner.js";

const runner = new URL("../dist/cursor-acp-runner.js", import.meta.url);

function fakeServerSource() {
  return `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const config = JSON.parse(readFileSync(join(process.env.CURSOR_CONFIG_DIR, "cli-config.json"), "utf8"));
if (config.approvalMode !== "allowlist" || config.sandbox.networkAccess !== "disabled" || !config.permissions.deny.includes("Shell(*)") || !config.permissions.deny.includes("Write(**)") || !config.permissions.deny.includes("Read(.env*)") || !config.permissions.deny.includes("Read(**/.env*)")) process.exit(19);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let promptId = null;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.FAKE_EXIT === "1") process.exit(23);
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  }
  else if (message.method === "authenticate") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "fresh-acp",
    configOptions: [
      { id: "mode", currentValue: "agent", options: [{ value: "ask", name: "Ask" }] },
      { id: "model", currentValue: "auto", options: [{ value: "gpt-5.6-luna[reasoning=high]", name: "GPT 5.6 Luna High" }] }
    ]
  } });
  else if (message.method === "session/set_config_option") {
    if (process.env.FAKE_FORBID_MODEL === "1" && message.params.configId === "model") process.exit(24);
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [{ id: message.params.configId, currentValue: message.params.value }] } });
  }
  else if (message.method === "session/prompt") {
    promptId = message.id;
    if (process.env.FAKE_PERMISSION === "1") send({ jsonrpc: "2.0", id: 91, method: "session/request_permission", params: { sessionId: "fresh-acp", toolCall: { toolCallId: "write-1" }, options: [] } });
    else finish();
  } else if (message.id === 91 && message.result?.outcome?.outcome === "cancelled") finish();
});
function finish() {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fresh-acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "{\\\"status\\\":\\\"passed\\\"}" } } } });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
}
`;
}

function invoke(mode = "success", model = "gpt-5.6-luna-high") {
  const root = mkdtempSync(join(tmpdir(), "qube-cursor-acp-test-"));
  const server = join(root, "fake-acp.mjs");
  writeFileSync(server, fakeServerSource(), "utf8");
  try {
    const forwarded = ["--acp-review"];
    if (model) forwarded.push("--model", model);
    forwarded.push("--workspace", root);
    return spawnSync(process.execPath, [
      runner.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"),
      "--cursor-executable", process.execPath,
      "--cursor-prefix-json", JSON.stringify([server]),
      "--", ...forwarded,
    ], {
      input: "review safely",
      encoding: "utf8",
      env: {
        ...process.env,
        ...(mode === "permission" ? { FAKE_PERMISSION: "1" } : {}),
        ...(mode === "exit" ? { FAKE_EXIT: "1" } : {}),
        ...(model === null ? { FAKE_FORBID_MODEL: "1" } : {}),
      },
      timeout: 10_000,
      windowsHide: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Cursor Windows ACP runner", () => {
  it("parses bounded runner arguments and selects an unambiguous model option", () => {
    assert.deepEqual(parseRunnerOptions(["--cursor-executable", "cursor", "--cursor-prefix-json", "[]", "--", "--version"]), {
      cursorExecutable: "cursor",
      cursorPrefix: [],
      forwarded: ["--version"],
    });
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [{ value: "gpt-5.6-luna[reasoning=high]", name: "GPT 5.6 Luna High" }] }] }, "gpt-5.6-luna-high"), "gpt-5.6-luna[reasoning=high]");
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [{ value: "one" }, { value: "two" }] }] }, "missing"), null);
  });

  it("runs a fresh ACP session with a strict isolated config and returns one envelope", () => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.type, "result");
    assert.equal(envelope.session_id, "fresh-acp");
    assert.equal(envelope.result, '{"status":"passed"}');
  });

  it("preserves the nullable model contract by keeping the ACP session default", () => {
    const result = invoke("success", null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result, '{"status":"passed"}');
  });

  it("cancels and rejects every requested capability", () => {
    const result = invoke("permission");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Blocked by policy/);
    assert.equal(result.stdout, "");
  });

  it("fails promptly when the ACP process exits with a request pending", () => {
    const started = Date.now();
    const result = invoke("exit");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ended before completing the review/);
    assert.ok(Date.now() - started < 3_000);
  });
});
