import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

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

function normalizeModel(value: string): string {
  return value.toLowerCase().replace(/\[[^\]]*\]$/u, "").replace(/[^a-z0-9]+/gu, "");
}

function configOptions(value: unknown): JsonObject[] {
  if (!isRecord(value) || !Array.isArray(value.configOptions)) return [];
  return value.configOptions.filter(isRecord);
}

export function selectCursorAcpModel(session: unknown, requested: string): string | null {
  const model = configOptions(session).find(option => option.id === "model");
  if (!model || !Array.isArray(model.options)) return null;
  const options = model.options.filter(isRecord);
  const exact = options.find(option => option.value === requested);
  if (typeof exact?.value === "string") return exact.value;
  const requestedBase = normalizeModel(requested.replace(/-(?:low|medium|high)$/iu, ""));
  const requestedEffort = /-(low|medium|high)$/iu.exec(requested)?.[1]?.toLowerCase() ?? null;
  const matches = options.filter(option => {
    if (typeof option.value !== "string") return false;
    const label = `${option.value} ${typeof option.name === "string" ? option.name : ""}`;
    if (!normalizeModel(label).includes(requestedBase)) return false;
    return requestedEffort === null || new RegExp(`(?:reasoning|effort)[= _-]?${requestedEffort}|\\b${requestedEffort}\\b`, "iu").test(label);
  });
  return matches.length === 1 && typeof matches[0].value === "string" ? matches[0].value : null;
}

function currentConfigValue(value: unknown, configId: string): unknown {
  return configOptions(value).find(option => option.id === configId)?.currentValue;
}

function configuredModelValues(value: unknown): string[] {
  const model = configOptions(value).find(option => option.id === "model");
  return model && Array.isArray(model.options)
    ? model.options.filter(isRecord).map(option => option.value).filter((option): option is string => typeof option === "string")
    : [];
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

async function runAcp(options: RunnerOptions): Promise<void> {
  const forwarded = [...options.forwarded];
  if (forwarded.shift() !== "--acp-review") throw new Error("Missing --acp-review marker.");
  const workspace = requiredValue(forwarded, "--workspace");
  const requestedModel = requiredValue(forwarded, "--model");
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
  let permissionRequests = 0;
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
      permissionRequests += 1;
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
    const modelValue = selectCursorAcpModel(session, requestedModel) ?? requestedModel;
    let modelResult: JsonObject;
    try {
      modelResult = await request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: modelValue });
    } catch (error) {
      throw new Error(`Cursor ACP rejected model ${requestedModel}. Available ACP values: ${configuredModelValues(session).join(", ") || "none"}.`, { cause: error });
    }
    if (currentConfigValue(modelResult, "model") !== modelValue) throw new Error("Cursor ACP did not confirm the requested model.");
    await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
    if (protocolFault) throw protocolFault;
    if (permissionRequests > 0) throw new Error("Blocked by policy: Cursor requested a capability outside QUBE's read-only ACP client.");
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
