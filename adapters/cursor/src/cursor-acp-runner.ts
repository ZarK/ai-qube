import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { cursorAcpModelOptions, resolveCursorAcpModel } from "./model_resolution.js";

type JsonObject = Record<string, unknown>;

interface RunnerOptions {
  cursorExecutable: string;
  cursorPrefix: string[];
  forwarded: string[];
}

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function optionalValue(args: string[], name: string): string | null {
  if (!args.includes(name)) return null;
  return requiredValue(args, name);
}

export function parseRunnerOptions(args: string[]): RunnerOptions {
  const separator = args.indexOf("--");
  if (separator === -1) throw new Error("Cursor runner arguments require -- before forwarded arguments.");
  const runnerArgs = args.slice(0, separator);
  const cursorExecutable = requiredValue(runnerArgs, "--cursor-executable");
  const encodedPrefix = requiredValue(runnerArgs, "--cursor-prefix-json");
  let parsedPrefix: unknown;
  try { parsedPrefix = JSON.parse(encodedPrefix); }
  catch { throw new Error("--cursor-prefix-json must be valid JSON."); }
  if (!Array.isArray(parsedPrefix) || !parsedPrefix.every(value => typeof value === "string")) {
    throw new Error("--cursor-prefix-json must contain an array of strings.");
  }
  return { cursorExecutable, cursorPrefix: parsedPrefix, forwarded: args.slice(separator + 1) };
}

function configOptions(value: unknown): JsonObject[] {
  if (!isRecord(value) || !Array.isArray(value.configOptions)) return [];
  return value.configOptions.filter(isRecord);
}

export function selectCursorAcpModel(session: unknown, requested: string): string | null {
  return resolveCursorAcpModel(cursorAcpModelOptions(session), requested)?.transportValue ?? null;
}

function currentConfigValue(value: unknown, configId: string): unknown {
  return configOptions(value).find(option => option.id === configId)?.currentValue;
}

function configuredModelValues(value: unknown): string[] {
  return cursorAcpModelOptions(value).map(option => option.value);
}

function strictConfig(): string {
  return `${JSON.stringify({
    version: 1,
    approvalMode: "allowlist",
    permissions: {
      allow: ["Read(**)"],
      deny: [
        "Shell(*)",
        "Write(**)",
        "Mcp(*)",
        "WebFetch(*)",
        "Read(.env*)",
        "Read(**/.env*)",
        "Read(.git/**)",
        "Read(**/.git/**)",
        "Read(.npmrc)",
        "Read(**/.npmrc)",
        "Read(.pypirc)",
        "Read(**/.pypirc)",
        "Read(.netrc)",
        "Read(**/.netrc)",
        "Read(**/*.key)",
        "Read(**/*.pem)",
        "Read(**/*credential*)",
        "Read(**/*secret*)",
      ],
    },
    sandbox: { mode: "disabled", networkAccess: "disabled" },
  }, null, 2)}\n`;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

function proxy(options: RunnerOptions): never {
  const result = spawnSync(options.cursorExecutable, [...options.cursorPrefix, ...options.forwarded], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function probeAcpModels(options: RunnerOptions): Promise<void> {
  const configDirectory = mkdtempSync(join(tmpdir(), "qube-cursor-models-"));
  writeFileSync(join(configDirectory, "cli-config.json"), strictConfig(), { encoding: "utf8", mode: 0o600 });
  const child = spawn(options.cursorExecutable, [...options.cursorPrefix, "acp"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CURSOR_CONFIG_DIR: configDirectory,
      CURSOR_AGENT_DISABLE_DEBUG_LOG: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const childExit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.stderr.resume();
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  const send = (message: JsonObject): void => { child.stdin.write(`${JSON.stringify(message)}\n`, "utf8"); };
  const rejectPending = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const request = (method: string, params: JsonObject): Promise<JsonObject> => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Cursor ACP ${method} timed out during model compatibility inspection.`));
      }, 4_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
  };
  child.once("error", error => rejectPending(new Error(`Cursor ACP model inspection failed to start: ${error.message}`, { cause: error })));
  child.once("exit", (code, signal) => {
    if (pending.size === 0) return;
    const outcome = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    rejectPending(new Error(`Cursor ACP model inspection ended early (${outcome}).`));
  });
  createInterface({ input: child.stdout }).on("line", line => {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { rejectPending(new Error("Cursor ACP model inspection returned malformed JSON-RPC output.")); return; }
    if (!isRecord(message)) { rejectPending(new Error("Cursor ACP model inspection returned a non-object message.")); return; }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (isRecord(message.error)) waiter.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Cursor ACP model inspection failed."));
      else waiter.resolve(isRecord(message.result) ? message.result : {});
      return;
    }
    if (message.method === "session/request_permission" && "id" in message) {
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    if (typeof message.method === "string" && "id" in message) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "QUBE model inspection exposes no client capabilities." } });
    }
  });
  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "qube-model-inspection", version: "1" },
    });
    await request("authenticate", { methodId: "cursor_login" });
    const session = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const modelOptions = cursorAcpModelOptions(session);
    if (modelOptions.length === 0) throw new Error("Cursor ACP did not advertise model options.");
    process.stdout.write(`${JSON.stringify({ version: 1, transport: "acp", options: modelOptions })}\n`);
  } finally {
    rejectPending(new Error("Cursor ACP model inspection closed."));
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await Promise.race([childExit, new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
    rmSync(configDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runAcp(options: RunnerOptions): Promise<void> {
  const forwarded = [...options.forwarded];
  if (forwarded.shift() !== "--acp-review") throw new Error("Missing --acp-review marker.");
  const workspace = requiredValue(forwarded, "--workspace");
  const transportModel = optionalValue(forwarded, "--model");
  const requestedModel = optionalValue(forwarded, "--requested-model") ?? transportModel;
  const prompt = await readStdin();
  if (prompt.trim() === "") throw new Error("Cursor ACP review requires a prompt on stdin.");

  const configDirectory = mkdtempSync(join(tmpdir(), "qube-cursor-config-"));
  writeFileSync(join(configDirectory, "cli-config.json"), strictConfig(), { encoding: "utf8", mode: 0o600 });
  const child = spawn(options.cursorExecutable, [...options.cursorPrefix, "acp"], {
    cwd: workspace,
    env: {
      ...process.env,
      CURSOR_CONFIG_DIR: configDirectory,
      CURSOR_AGENT_DISABLE_DEBUG_LOG: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const childExit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let agentText = "";
  let protocolFault: Error | null = null;
  let stderr = "";
  let finalEnvelope: JsonObject | null = null;

  const send = (message: JsonObject): void => { child.stdin.write(`${JSON.stringify(message)}\n`, "utf8"); };
  const request = (method: string, params: JsonObject): Promise<JsonObject> => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const failProtocol = (message: string): void => { protocolFault ??= new Error(message); };
  const rejectPending = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.once("error", error => rejectPending(new Error(`Cursor ACP process failed to start: ${error.message}`, { cause: error })));
  child.once("exit", (code, signal) => {
    if (pending.size === 0) return;
    const outcome = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    rejectPending(new Error(`Cursor ACP process ended before completing the review (${outcome}).`));
  });

  createInterface({ input: child.stdout }).on("line", line => {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { failProtocol("Cursor ACP returned malformed JSON-RPC output."); return; }
    if (!isRecord(message)) { failProtocol("Cursor ACP returned a non-object JSON-RPC message."); return; }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const waiter = pending.get(message.id);
      if (!waiter) { failProtocol("Cursor ACP returned a response for an unknown request."); return; }
      pending.delete(message.id);
      if (isRecord(message.error)) waiter.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Cursor ACP request failed."));
      else waiter.resolve(isRecord(message.result) ? message.result : {});
      return;
    }
    if (message.method === "session/request_permission" && "id" in message) {
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    if (typeof message.method === "string" && "id" in message) {
      failProtocol(`Cursor ACP requested unsupported client method ${message.method}.`);
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "QUBE review clients do not expose mutating client capabilities." } });
      return;
    }
    if (message.method === "session/update" && isRecord(message.params) && isRecord(message.params.update)) {
      const update = message.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && isRecord(update.content) && typeof update.content.text === "string") {
        agentText += update.content.text;
      } else if (update.type === "agent_message_chunk" && typeof update.textDelta === "string") {
        agentText += update.textDelta;
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });

  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "qube-review", version: "1" },
    });
    await request("authenticate", { methodId: "cursor_login" });
    const session = await request("session/new", { cwd: workspace, mcpServers: [] });
    if (typeof session.sessionId !== "string" || session.sessionId === "") throw new Error("Cursor ACP did not create a session.");
    const modeResult = await request("session/set_config_option", { sessionId: session.sessionId, configId: "mode", value: "ask" });
    if (currentConfigValue(modeResult, "mode") !== "ask") throw new Error("Cursor ACP did not enter Ask mode.");
    if (transportModel) {
      const availableModels = configuredModelValues(session);
      if (!availableModels.includes(transportModel)) {
        throw new Error(`Cursor model compatibility failed: requested ${requestedModel}; transport acp; probed value ${transportModel} is unavailable. Available ACP values: ${availableModels.join(", ") || "none"}. Rerun init or doctor and select a compatible Cursor model.`);
      }
      let modelResult: JsonObject;
      try {
        modelResult = await request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: transportModel });
      } catch (error) {
        throw new Error(`Cursor model compatibility failed: requested ${requestedModel}; transport acp rejected probed value ${transportModel}. Available ACP values: ${availableModels.join(", ") || "none"}. Rerun init or doctor and select a compatible Cursor model.`, { cause: error });
      }
      if (currentConfigValue(modelResult, "model") !== transportModel) throw new Error("Cursor ACP did not confirm the probed transport model.");
    }
    await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
    if (protocolFault) throw protocolFault;
    if (agentText.trim() === "") throw new Error("Cursor ACP returned no final agent message.");
    finalEnvelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: agentText,
      session_id: session.sessionId,
    };
  } finally {
    rejectPending(new Error("Cursor ACP process closed."));
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await Promise.race([childExit, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
    rmSync(configDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  if (!finalEnvelope) throw new Error("Cursor ACP did not produce a final envelope.");
  process.stdout.write(`${JSON.stringify(finalEnvelope)}\n`);
  if (stderr.trim() !== "") process.stderr.write(stderr);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRunnerOptions(args);
  if (options.forwarded[0] === "--acp-models") return probeAcpModels(options);
  if (options.forwarded[0] !== "--acp-review") proxy(options);
  await runAcp(options);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
