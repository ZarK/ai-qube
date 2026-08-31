import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { parseRunnerOptions, selectCursorAcpModel } from "../dist/cursor-acp-runner.js";

const runner = new URL("../dist/cursor-acp-runner.js", import.meta.url);

function fakeServerSource() {
  return `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const config = JSON.parse(readFileSync(join(process.env.CURSOR_CONFIG_DIR, "cli-config.json"), "utf8"));
if (config.approvalMode !== "allowlist" || config.sandbox.networkAccess !== "disabled" || !config.permissions.deny.includes("Shell(*)") || !config.permissions.deny.includes("Write(**)") || !config.permissions.deny.includes("Read(.env*)") || !config.permissions.deny.includes("Read(**/.env*)")) process.exit(19);
const modelOptions = JSON.parse(process.env.FAKE_MODELS ?? '[{"value":"gpt-5.6-luna[reasoning=high]","name":"GPT 5.6 Luna High"}]');
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let promptId = null;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.FAKE_EXIT === "1") process.exit(23);
    if (process.env.FAKE_MALFORMED === "1") { process.stdout.write("not-json\\n"); return; }
    if (process.env.FAKE_TIMEOUT === "1") return;
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  }
  else if (message.method === "authenticate") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "fresh-acp",
    configOptions: [
      { id: "mode", currentValue: "agent", options: [{ value: "ask", name: "Ask" }] },
      { id: "model", currentValue: "auto", options: modelOptions }
    ]
  } });
  else if (message.method === "session/set_config_option") {
    if (process.env.FAKE_FORBID_MODEL === "1" && message.params.configId === "model") process.exit(24);
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [{ id: message.params.configId, currentValue: message.params.value }] } });
  }
  else if (message.method === "session/prompt") {
    if (process.env.FAKE_PROMPT_MARKER) writeFileSync(process.env.FAKE_PROMPT_MARKER, "prompted", "utf8");
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

function invoke({ mode = "success", transportModel = "gpt-5.6-luna[reasoning=high]", requestedModel = "gpt-5.6-luna-high", models, probe = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qube-cursor-acp-test-"));
  const server = join(root, "fake-acp.mjs");
  writeFileSync(server, fakeServerSource(), "utf8");
  try {
    const promptMarker = join(root, "prompt-marker");
    const forwarded = probe ? ["--acp-models"] : ["--acp-review"];
    if (!probe && transportModel) forwarded.push("--model", transportModel);
    if (!probe && requestedModel) forwarded.push("--requested-model", requestedModel);
    if (!probe) forwarded.push("--workspace", root);
    const result = spawnSync(process.execPath, [
      runner.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"),
      "--cursor-executable", process.execPath,
      "--cursor-prefix-json", JSON.stringify([server]),
      "--", ...forwarded,
    ], {
      input: probe ? "" : "review safely",
      encoding: "utf8",
      env: {
        ...process.env,
        ...(mode === "permission" ? { FAKE_PERMISSION: "1" } : {}),
        ...(mode === "exit" ? { FAKE_EXIT: "1" } : {}),
        ...(mode === "malformed" ? { FAKE_MALFORMED: "1" } : {}),
        ...(mode === "timeout" ? { FAKE_TIMEOUT: "1" } : {}),
        ...(transportModel === null ? { FAKE_FORBID_MODEL: "1" } : {}),
        ...(models ? { FAKE_MODELS: JSON.stringify(models) } : {}),
        FAKE_PROMPT_MARKER: promptMarker,
      },
      timeout: 10_000,
      windowsHide: true,
    });
    return { ...result, prompted: existsSync(promptMarker) };
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
    for (const effort of ["low", "medium", "high"]) {
      for (const fast of [false, true]) {
        const value = `grok-4.6[effort=${effort},fast=${fast}]`;
        const display = `cursor-grok-4.6-${effort}${fast ? "-fast" : ""}`;
        assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [{ value }] }] }, display), value);
      }
    }
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [{ value: "one" }, { value: "two" }] }] }, "missing"), null);
    const grokSession = { configOptions: [{ id: "model", options: [
      { value: "grok-4.6[effort=high,fast=true]", name: "Grok 4.6" },
      { value: "composer-2.5[fast=true]", name: "Composer 2.5" },
    ] }] };
    assert.equal(selectCursorAcpModel(grokSession, "cursor-grok-4.6-high"), null);
    assert.equal(selectCursorAcpModel(grokSession, "cursor-grok-4.6-high-fast"), "grok-4.6[effort=high,fast=true]");
    assert.equal(selectCursorAcpModel(grokSession, "composer-2.5"), null);
    assert.equal(selectCursorAcpModel(grokSession, "cursor-grok-4.6-medium-fast"), null);
    assert.equal(selectCursorAcpModel(grokSession, "grok-4.6[effort=high,fast=true]"), "grok-4.6[effort=high,fast=true]");
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [
      { value: "grok-4.6[effort=high,fast=false]" },
      { value: "grok-4.6[effort=high,fast=false]" },
    ] }] }, "cursor-grok-4.6-high"), null);
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [
      { value: "grok-4.6[effort=high,fast=false,tier=preview]" },
    ] }] }, "cursor-grok-4.6-high"), null);
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [
      { value: "grok-4.6[effort=high,reasoning=high,fast=false]" },
    ] }] }, "cursor-grok-4.6-high"), null);
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [
      { value: "grok-4.6[effort=high,fast=false,fast=false]" },
    ] }] }, "cursor-grok-4.6-high"), null);
    assert.equal(selectCursorAcpModel({ configOptions: [{ id: "model", options: [
      { value: "grok-4.6[effort=high,fast=false]" },
    ] }] }, "cursor-grok-4.6-high-high"), null);
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
    const result = invoke({ transportModel: null, requestedModel: null });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result, '{"status":"passed"}');
  });

  it("cancels every requested capability without granting it", () => {
    const result = invoke({ mode: "permission" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result, '{"status":"passed"}');
  });

  it("fails promptly when the ACP process exits with a request pending", () => {
    const started = Date.now();
    const result = invoke({ mode: "exit" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ended before completing the review/);
    assert.ok(Date.now() - started < 3_000);
  });

  it("inspects ACP model options without sending a prompt", () => {
    const result = invoke({
      probe: true,
      models: [
        { value: "grok-4.6[effort=high,fast=true]", name: "Grok High Fast" },
        { value: "grok-4.6[effort=medium,fast=false]", name: "Grok Medium" },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.prompted, false);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1,
      transport: "acp",
      options: [
        { value: "grok-4.6[effort=high,fast=true]", name: "Grok High Fast" },
        { value: "grok-4.6[effort=medium,fast=false]", name: "Grok Medium" },
      ],
    });
  });

  it("fails before prompting when the probed transport value drifts", () => {
    const result = invoke({
      transportModel: "grok-4.6[effort=high,fast=true]",
      requestedModel: "cursor-grok-4.6-high-fast",
      models: [{ value: "grok-4.6[effort=medium,fast=false]", name: "Grok Medium" }],
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.prompted, false);
    assert.match(result.stderr, /^Cursor model compatibility failed: requested cursor-grok-4\.6-high-fast; transport acp;/);
  });

  it("fails closed on malformed and timed-out ACP compatibility responses", () => {
    const malformed = invoke({ probe: true, mode: "malformed" });
    assert.notEqual(malformed.status, 0);
    assert.equal(malformed.prompted, false);
    assert.match(malformed.stderr, /malformed JSON-RPC/);

    const started = Date.now();
    const timedOut = invoke({ probe: true, mode: "timeout" });
    assert.notEqual(timedOut.status, 0);
    assert.equal(timedOut.prompted, false);
    assert.match(timedOut.stderr, /timed out during model compatibility inspection/);
    assert.ok(Date.now() - started < 6_000);
  });
});
