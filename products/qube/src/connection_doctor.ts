import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { validateConfig } from "@tjalve/aie";
import { evaluateGitHubReadiness, type GitHubReadiness, type GitHubRole } from "@tjalve/qube-adapter-github";

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
  readonly connections: readonly ConnectionDoctorProbeResult[];
  readonly githubReadiness: GitHubReadiness | null;
}

export interface ConnectionDoctorProbeResult extends ConnectionProbeResult {
  readonly connectionId: string;
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
      githubReadiness: null,
    });
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return Object.freeze({
      status: "fail",
      configPath,
      summary: "Executor config is malformed JSON; provider connections cannot be verified.",
      connections: Object.freeze([]),
      githubReadiness: null,
    });
  }

  const validated = validateConfig(config);
  if (!validated.ok || !validated.config) {
    const firstError = validated.errors[0];
    return Object.freeze({
      status: "fail",
      configPath,
      summary: `Executor config is invalid${firstError ? ` at ${firstError.path}: ${firstError.message}` : "."}`,
      connections: Object.freeze([]),
      githubReadiness: null,
    });
  }
  config = validated.config;

  const githubReadiness = options.probe
    ? null
    : await evaluateGitHubReadiness({
      cwd: options.cwd,
      env: options.env ?? process.env,
      offline: options.mode === "offline",
      roles: selectedGitHubRoles(validated.config),
      publisher: validated.config.providers.review.kind === "github" ? validated.config.providers.review.publisher : null,
    });

  const configured = configuredConnections(config);
  if (configured.length === 0) {
    return Object.freeze({
      status: "unverified",
      configPath,
      summary: "Executor config has no supported provider connections to probe.",
      connections: Object.freeze([]),
      githubReadiness,
    });
  }

  const probe = options.probe ?? runConnectionProbe;
  const results = await Promise.all(configured.map(async ({ contract, config: connectionConfig, connectionId }) => {
    const result = contract.adapterId === "github" && githubReadiness
      ? githubConnectionResult(githubReadiness)
      : await probe(contract, {
        mode: options.mode ?? "live",
        env: options.env ?? process.env,
        config: connectionConfig,
        exec: executeCommand,
        fetch: fetchConnection,
      });
    return Object.freeze({ ...result, connectionId });
  }));
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
    githubReadiness,
  });
}

function selectedGitHubRoles(config: ReturnType<typeof validateConfig> extends { config?: infer C } ? NonNullable<C> : never): readonly GitHubRole[] {
  const roles: GitHubRole[] = [];
  if (config.providers.work.kind === "github") roles.push("work");
  if (config.providers.review.kind === "github") roles.push("review");
  if (config.providers.ci.kind === "github") roles.push("ci");
  if (roles.length === 0 && config.providers.connections.github) roles.push("repository-priming");
  return Object.freeze(roles);
}

function githubConnectionResult(readiness: GitHubReadiness): ConnectionProbeResult {
  const status: ConnectionProbeStatus = readiness.status === "needs-action"
    ? "fail"
    : readiness.status === "ready"
      ? "pass"
      : "unverified";
  return Object.freeze({
    adapterId: "github",
    probeId: "github-readiness",
    status,
    authMethod: "cli-delegated",
    summary: readiness.summary,
    verifyCommand: readiness.host ? `gh auth status --active --hostname ${readiness.host} --json hosts` : "gh auth status --json hosts",
    readOnly: true,
  });
}

export function formatConnectionDoctor(result: ConnectionDoctorResult): string {
  const lines = ["Connections:"];
  if (result.connections.length === 0) lines.push(`- ${result.status}: ${result.summary}`);
  for (const connection of result.connections) {
    lines.push(`- ${connection.connectionId}: ${connection.status} — ${connection.summary}`);
    lines.push(`  Verify: ${connection.verifyCommand}`);
  }
  if (result.githubReadiness) {
    const github = result.githubReadiness;
    lines.push(`- GitHub readiness: ${github.status} (${github.reasonCode}); roles=${github.roles.join(", ") || "none"}`);
    lines.push(`  Host: ${github.host ?? "not resolved"}; repository: ${github.repository ?? "not resolved"}; account: ${github.accountLogin ?? "none"}`);
    lines.push(`  Credential: ${github.credentialSource.kind}${github.credentialSource.name ? ` (${github.credentialSource.name})` : ""}`);
    lines.push(`  ${github.summary}`);
    for (const capability of github.capabilities) {
      lines.push(`  - ${capability.capability}: ${capability.status} (${capability.reasonCode}) — ${capability.summary}`);
    }
    if (github.nextAction) lines.push(`  Next: ${github.nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}

function configuredConnections(config: unknown): readonly { readonly contract: ConnectionContract; readonly config: Readonly<Record<string, unknown>>; readonly connectionId: string }[] {
  if (!isRecord(config) || !isRecord(config.providers)) return [];
  const providers = config.providers;
  const registry = isRecord(providers.connections) ? providers.connections : {};
  const configured: { readonly contract: ConnectionContract; readonly config: Readonly<Record<string, unknown>>; readonly connectionId: string }[] = [];
  const signatures = new Set<string>();
  const selectedAdapterIds = new Set<string>();
  const selections = [["work", providers.work], ["review", providers.review], ["ci", providers.ci]] as const;
  for (const [role, selectionValue] of selections) {
    if (!isRecord(selectionValue)) continue;
    const selection = selectionValue;
    if (typeof selection.kind !== "string") continue;
    const contract = CONNECTIONS.get(selection.kind);
    if (!contract) continue;
    selectedAdapterIds.add(contract.adapterId);
    const sharedValue = registry[selection.kind];
    const sharedConfig = isRecord(sharedValue) ? sharedValue : {};
    const adapterValue = selection[selection.kind];
    const adapterConfig = isRecord(adapterValue) ? adapterValue : {};
    const connectionValue = selection.connection;
    const connectionConfig = isRecord(connectionValue) ? connectionValue : {};
    const resolvedConfig = Object.freeze({ ...sharedConfig, ...connectionConfig, ...adapterConfig });
    const signature = connectionSignature(contract.adapterId, resolvedConfig);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    configured.push({ contract, config: resolvedConfig, connectionId: `${role}:${contract.adapterId}` });
  }
  if (isRecord(registry)) {
    for (const [adapterId, connectionValue] of Object.entries(registry)) {
      const contract = CONNECTIONS.get(adapterId);
      if (!contract || selectedAdapterIds.has(adapterId) || !isRecord(connectionValue)) continue;
      const signature = connectionSignature(adapterId, connectionValue);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      configured.push({ contract, config: Object.freeze({ ...connectionValue }), connectionId: adapterId });
    }
  }
  return Object.freeze(configured);
}

function connectionSignature(adapterId: string, config: Readonly<Record<string, unknown>>): string {
  return `${adapterId}:${JSON.stringify(Object.entries(config).sort(([left], [right]) => left.localeCompare(right)))}`;
}

function findExecutorConfig(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, ".qube", "aie", "config.json");
    if (existsSync(candidate)) return candidate;
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
