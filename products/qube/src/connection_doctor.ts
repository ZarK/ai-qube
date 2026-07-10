import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

import {
  gitLabConnectionContract,
  githubConnectionContract,
  jenkinsConnectionContract,
  jiraConnectionContract,
  linearConnectionContract,
  readConnectionJsonResponse,
  runConnectionProbe,
  type ConnectionCommandResult,
  type ConnectionContract,
  type ConnectionProbeMode,
  type ConnectionProbeOptions,
  type ConnectionProbeResult,
  type ConnectionProbeStatus,
  type ConnectionHttpRequest,
  type ConnectionHttpResponse,
} from "@tjalve/qube-core";

const CONNECTIONS = Object.freeze(new Map<string, ConnectionContract>([
  [githubConnectionContract.adapterId, githubConnectionContract],
  [gitLabConnectionContract.adapterId, gitLabConnectionContract],
  [linearConnectionContract.adapterId, linearConnectionContract],
  [jiraConnectionContract.adapterId, jiraConnectionContract],
  [jenkinsConnectionContract.adapterId, jenkinsConnectionContract],
]));

export interface ConnectionDoctorResult {
  readonly status: ConnectionProbeStatus;
  readonly configPath: string | null;
  readonly summary: string;
  readonly connections: readonly ConnectionProbeResult[];
}

export interface ConnectionDoctorOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly mode?: ConnectionProbeMode;
  readonly probe?: (contract: ConnectionContract, options: ConnectionProbeOptions) => Promise<ConnectionProbeResult>;
}

export async function runConnectionDoctor(options: ConnectionDoctorOptions): Promise<ConnectionDoctorResult> {
  const configPath = findExecutorConfig(options.cwd);
  if (!configPath) {
    return Object.freeze({
      status: "unverified",
      configPath: null,
      summary: "No Executor config was found; no provider connection was verified.",
      connections: Object.freeze([]),
    });
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return Object.freeze({
      status: "unverified",
      configPath,
      summary: "Executor config could not be read as JSON; no provider connection was verified.",
      connections: Object.freeze([]),
    });
  }

  const configured = configuredConnections(config);
  if (configured.length === 0) {
    return Object.freeze({
      status: "unverified",
      configPath,
      summary: "Executor config has no supported provider connections to probe.",
      connections: Object.freeze([]),
    });
  }

  const probe = options.probe ?? runConnectionProbe;
  const results = await Promise.all(configured.map(({ contract, config: connectionConfig }) => probe(contract, {
    mode: options.mode ?? "live",
    env: options.env ?? process.env,
    config: connectionConfig,
    exec: executeCommand,
    fetch: fetchConnection,
  })));
  const status = rollupStatus(results);
  return Object.freeze({
    status,
    configPath,
    summary: status === "pass"
      ? "All configured provider connections passed their read-only probes."
      : status === "fail"
        ? "One or more configured provider connections failed their read-only probes."
        : "Configured provider connections remain explicitly unverified.",
    connections: Object.freeze(results),
  });
}

export function formatConnectionDoctor(result: ConnectionDoctorResult): string {
  const lines = ["Connections:"];
  if (result.connections.length === 0) lines.push(`- unverified: ${result.summary}`);
  for (const connection of result.connections) {
    lines.push(`- ${connection.adapterId}: ${connection.status} — ${connection.summary}`);
    lines.push(`  Verify: ${connection.verifyCommand}`);
  }
  return `${lines.join("\n")}\n`;
}

function configuredConnections(config: unknown): readonly { readonly contract: ConnectionContract; readonly config: Readonly<Record<string, unknown>> }[] {
  if (!isRecord(config) || !isRecord(config.providers)) return [];
  const providers = config.providers;
  const selections = [providers.work, providers.review, providers.ci].filter(isRecord);
  const configured = new Map<string, { readonly contract: ConnectionContract; readonly config: Readonly<Record<string, unknown>> }>();
  for (const selection of selections) {
    if (typeof selection.kind !== "string") continue;
    const contract = CONNECTIONS.get(selection.kind);
    if (!contract) continue;
    const adapterValue = selection[selection.kind];
    const adapterConfig = isRecord(adapterValue) ? adapterValue : {};
    const connectionValue = selection.connection;
    const connectionConfig = isRecord(connectionValue) ? connectionValue : {};
    const existing = configured.get(contract.adapterId);
    configured.set(contract.adapterId, {
      contract,
      config: Object.freeze({ ...existing?.config, ...selection, ...adapterConfig, ...connectionConfig }),
    });
  }
  return Object.freeze([...configured.values()]);
}

function findExecutorConfig(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    for (const relativePath of [".qube/aie/config.json", "aie.config.json"]) {
      const candidate = path.join(current, relativePath);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function rollupStatus(results: readonly ConnectionProbeResult[]): ConnectionProbeStatus {
  if (results.some(result => result.status === "fail")) return "fail";
  if (results.some(result => result.status === "unverified")) return "unverified";
  return "pass";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function executeCommand(command: string, args: readonly string[], timeoutMs: number): Promise<ConnectionCommandResult> {
  return new Promise(resolve => {
    execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      const timedOut = error !== null && (error.killed === true || error.code === "ETIMEDOUT");
      resolve({ exitCode, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

async function fetchConnection(request: ConnectionHttpRequest): Promise<ConnectionHttpResponse> {
  const headers: Record<string, string> = { ...request.headers };
  if (request.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${request.basicAuth.username}:${request.basicAuth.password}`, "utf8").toString("base64")}`;
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await readConnectionJsonResponse(response) };
}
